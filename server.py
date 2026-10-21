from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import math
import os
import statistics
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles


ROOT = Path(__file__).resolve().parent
logger = logging.getLogger(__name__)

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
CACHE_SECONDS = 15 * 60
LOOKBACK_DAYS = 30
FEATURE_COUNT = 10

CITIES: list[dict[str, object]] = [
    {"id": "bangalore", "name": "Bengaluru", "latitude": 12.9716, "longitude": 77.5946, "heatThresholdC": 35.2, "dataName": "Bangalore"},
    {"id": "bhubaneswar", "name": "Bhubaneswar", "latitude": 20.2961, "longitude": 85.8245, "heatThresholdC": 39.6, "dataName": "Bhubhneshwar"},
    {"id": "chennai", "name": "Chennai", "latitude": 13.0827, "longitude": 80.2707, "heatThresholdC": 39.4, "dataName": "Chennai"},
    {"id": "delhi-ncr", "name": "Delhi NCR", "latitude": 28.6139, "longitude": 77.2090, "heatThresholdC": 41.7, "dataName": "Delhi_NCR"},
    {"id": "jodhpur", "name": "Jodhpur", "latitude": 26.2389, "longitude": 73.0243, "heatThresholdC": 35.2, "dataName": "Jodhpur"},
    {"id": "lucknow", "name": "Lucknow", "latitude": 26.8467, "longitude": 80.9462, "heatThresholdC": 42.1, "dataName": "Lucknow"},
    {"id": "mumbai", "name": "Mumbai", "latitude": 19.0760, "longitude": 72.8777, "heatThresholdC": 35.6, "dataName": "Mumbai"},
]
CITY_BY_ID = {str(city["id"]): city for city in CITIES}
CITY_BY_DATA_NAME = {str(city["dataName"]): city for city in CITIES}
CITY_BY_DATA_NAME["Bhubaneswar"] = CITY_BY_DATA_NAME["Bhubhneshwar"]
for city in CITIES:
    CITY_BY_DATA_NAME[str(city["id"]).replace("-", "_")] = city


class PredictionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    city: str = Field(min_length=1)
    input_dates: list[date] = Field(min_length=LOOKBACK_DAYS, max_length=LOOKBACK_DAYS)
    input_sequence: list[list[float]] = Field(min_length=LOOKBACK_DAYS, max_length=LOOKBACK_DAYS)
    feature_order: list[str] = Field(min_length=FEATURE_COUNT, max_length=FEATURE_COUNT)
    source_mode: Literal["live", "historical"] = "live"
    source_timestamp: datetime | None = None

    @model_validator(mode="after")
    def validate_sequence(self) -> PredictionRequest:
        if any(right != left + timedelta(days=1) for left, right in zip(self.input_dates, self.input_dates[1:])):
            raise ValueError("input_dates must be consecutive daily dates in strictly increasing order")
        if any(len(row) != FEATURE_COUNT for row in self.input_sequence):
            raise ValueError(f"each input_sequence row must contain exactly {FEATURE_COUNT} features")
        if any(not math.isfinite(value) for row in self.input_sequence for value in row):
            raise ValueError("input_sequence values must be finite numbers")
        return self


class HistoricalDemoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    city: str = Field(min_length=1)
    as_of_date: date | None = None


class PredictionHorizon(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    horizon_days: int
    target_date: date
    predicted_max_c: float
    lower_c: float
    upper_c: float
    heat_probability: float
    alert_threshold: float
    model_alert: bool


class PredictionResponse(BaseModel):
    city: str
    source_mode: str
    source_timestamp: datetime | None
    input_end_date: date
    generated_at: datetime
    experimental: bool = True
    interval_method: str = "Historical residual intervals; live calibration not established"
    forecasts: list[PredictionHorizon]


def read_csv_rows(filename: str) -> list[dict[str, str]]:
    path = ROOT / filename
    if not path.is_file():
        return []
    with path.open(newline="", encoding="utf-8") as stream:
        return list(csv.DictReader(stream))


def read_model_artifacts() -> dict[str, object]:
    paths = {
        "lstm": ROOT / "heatshield_x_lstm.keras",
        "classifier_1": ROOT / "heat_classifier_1day.keras",
        "classifier_3": ROOT / "heat_classifier_3day.keras",
        "classifier_7": ROOT / "heat_classifier_7day.keras",
        "scaler": ROOT / "temperature_scaler.joblib",
    }
    missing = [name for name, path in paths.items() if not path.is_file()]
    state: dict[str, object] = {
        "models": {},
        "scaler": None,
        "loaded": False,
        "missing_artifacts": missing,
        "feature_order": None,
        "target_feature_index": None,
        "error": None,
    }
    if missing:
        state["error"] = "One or more trained model artifacts are missing."
        return state

    try:
        import joblib
        import tensorflow as tf

        models = {
            "lstm": tf.keras.models.load_model(paths["lstm"], compile=False),
            "classifier_1": tf.keras.models.load_model(paths["classifier_1"], compile=False),
            "classifier_3": tf.keras.models.load_model(paths["classifier_3"], compile=False),
            "classifier_7": tf.keras.models.load_model(paths["classifier_7"], compile=False),
        }
        scaler = joblib.load(paths["scaler"])
        config_path = ROOT / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8")) if config_path.is_file() else {}
        feature_order = config.get("feature_order")
        target_index = config.get("target_feature_index")
        if models["lstm"].input_shape != (None, LOOKBACK_DAYS, FEATURE_COUNT) or models["lstm"].output_shape != (None, 3):
            raise ValueError("forecast model signature does not match the configured horizons")
        if scaler.n_features_in_ != 1 or not isinstance(feature_order, list) or len(feature_order) != FEATURE_COUNT or target_index != 0:
            raise ValueError("scaler or recovered feature contract does not match model artifacts")
        for horizon in (1, 3, 7):
            model = models[f"classifier_{horizon}"]
            if model.input_shape != (None, LOOKBACK_DAYS, FEATURE_COUNT) or model.output_shape != (None, 1):
                raise ValueError(f"{horizon}-day classifier signature does not match the configured input")
        state["models"] = models
        state["scaler"] = scaler
        state["feature_order"] = feature_order
        state["target_feature_index"] = target_index
        state["loaded"] = True
    except Exception as error:
        state["error"] = f"Model artifacts could not be loaded: {type(error).__name__}."
    return state


def load_historical_data() -> dict[str, list[dict[str, object]]]:
    grouped: dict[str, list[dict[str, object]]] = {}
    path = ROOT / "cleaned_city_weather.csv"
    if not path.is_file():
        return grouped
    with path.open(newline="", encoding="utf-8") as stream:
        for row in csv.DictReader(stream):
            city = row.get("city", "")
            if city not in CITY_BY_DATA_NAME:
                continue
            try:
                maximum = float(row["temp_max_c"])
                record = {
                    "date": date.fromisoformat(row["date"]),
                    "maximumC": maximum,
                    "daySin": float(row["day_sin"]),
                    "dayCos": float(row["day_cos"]),
                    "minimumC": None,
                    "precipitationMm": None,
                }
                if not all(math.isfinite(record[key]) for key in ("maximumC", "daySin", "dayCos")):
                    continue
            except (KeyError, TypeError, ValueError):
                continue
            grouped.setdefault(city, []).append(record)
    for records in grouped.values():
        records.sort(key=lambda record: record["date"])
    return grouped


def load_metrics() -> dict[str, list[dict[str, object]]]:
    return {
        "forecasting": [
            {"Model": row["Model"], "Horizon_days": int(row["Horizon_days"]), "MAE_C": float(row["MAE_C"]), "RMSE_C": float(row["RMSE_C"]), "R2": float(row["R2"])}
            for row in read_csv_rows("forecast_metrics.csv")
        ],
        "classifiers": [
            {"Horizon_days": int(row["Horizon_days"]), "Alert_threshold": float(row["Alert_threshold"]), "Precision": float(row["Precision"]), "Recall": float(row["Recall"]), "F1": float(row["F1"]), "False_alarms": int(row["False_alarms"]), "Missed_extreme_days": int(row["Missed_extreme_days"])}
            for row in read_csv_rows("heat_classifier_metrics.csv")
        ],
        "uncertainty": [
            {"Horizon_days": int(row["Horizon_days"]), "Interval_radius_C": float(row["Interval_radius_C"]), "Mean_width_C": float(row["Mean_width_C"]), "Test_coverage_percent": float(row["Test_coverage_percent"])}
            for row in read_csv_rows("uncertainty_metrics.csv")
        ],
    }


def load_drift() -> list[dict[str, object]]:
    return [
        {"city": row["City"], "horizonDays": int(row["Horizon_days"]), "samples": int(row["Test_samples"]), "maeC": float(row["Test_MAE_C"]), "detections": int(row["Drift_detections"]), "firstDetection": row["First_detection"] or None}
        for row in read_csv_rows("drift_report.csv")
    ]


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.model_state = read_model_artifacts()
    app.state.historical = load_historical_data()
    app.state.metrics = load_metrics()
    app.state.drift = load_drift()
    app.state.weather_cache = {}
    app.state.weather_lock = asyncio.Lock()
    yield


app = FastAPI(title="HeatShield-X API", version="1.0.0", lifespan=lifespan)


@app.get("/api/health")
async def health(request: Request) -> dict[str, object]:
    model_state = request.app.state.model_state
    feature_order = model_state.get("feature_order")
    inference_enabled = bool(model_state.get("loaded") and feature_order and model_state.get("target_feature_index") is not None)


    return {
        "status": "ok" if model_state.get("loaded") else "degraded",
        "weather_provider": "Open-Meteo",
        "model_artifacts_loaded": bool(model_state.get("loaded")),
        "model_inference_enabled": inference_enabled,
        "historical_demo_enabled": inference_enabled and bool(request.app.state.historical),
        "live_model_inference_enabled": False,
        "model_error": model_state.get("error"),
        "historical_data_loaded": bool(request.app.state.historical),
    }


@app.get("/api/cities")
async def cities() -> dict[str, list[dict[str, object]]]:
    return {"cities": [{key: value for key, value in city.items() if key != "dataName"} for city in CITIES]}


async def fetch_weather(request: Request, city: dict[str, object], refresh: bool) -> dict[str, object]:
    cache: dict[str, dict[str, object]] = request.app.state.weather_cache
    city_id = str(city["id"])
    now = datetime.now(timezone.utc)
    cached = cache.get(city_id)
    if cached and not refresh and now - cached["cached_at"] < timedelta(seconds=CACHE_SECONDS):
        return {**cached["body"], "source": "cached"}

    params = {
        "latitude": city["latitude"],
        "longitude": city["longitude"],
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum",
        "current": "temperature_2m,apparent_temperature,wind_speed_10m",
        "timezone": "Asia/Kolkata",
        "forecast_days": 8,
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=4.0)) as client:
            response = await client.get(OPEN_METEO_URL, params=params)
            response.raise_for_status()
            payload = response.json()
        daily = payload.get("daily", {})
        dates = daily.get("time", [])
        maximums = daily.get("temperature_2m_max", [])
        minimums = daily.get("temperature_2m_min", [])
        precipitation = daily.get("precipitation_sum", [])
        current_data = payload.get("current", {})
        current = {
            "temperatureC": current_data.get("temperature_2m"),
            "apparentTemperatureC": current_data.get("apparent_temperature"),
            "windSpeedKmh": current_data.get("wind_speed_10m"),
        } if current_data else None
        body = {
            "city": city_id,
            "source": "live",
            "fetchedAt": now.isoformat(),
            "timezone": payload.get("timezone", "Asia/Kolkata"),
            "daily": [
                {"date": day, "maximumC": maximums[index] if index < len(maximums) else None, "minimumC": minimums[index] if index < len(minimums) else None, "precipitationMm": precipitation[index] if index < len(precipitation) else None}
                for index, day in enumerate(dates)
            ],
            "current": current,
        }
        cache[city_id] = {"body": body, "cached_at": now}
        return body
    except (httpx.HTTPError, ValueError, KeyError) as error:
        logger.exception("Open-Meteo request failed for city %s", city_id)
        if cached:
            return {
                **cached["body"],
                "source": "cached",
                "message": "Open-Meteo could not be reached; showing the last successful response.",
            }
        raise HTTPException(
            status_code=502,
            detail="Live weather is unavailable and no cached response exists.",
        ) from error


@app.get("/api/weather/coordinates")
async def weather_coordinates(
    request: Request,
    latitude: float = Query(ge=6.0, le=38.5),
    longitude: float = Query(ge=68.0, le=98.5),
    refresh: bool = False,
) -> dict[str, object]:
    """Return live weather for any selected point within the India map extent."""
    cache_key = f"map-point-{latitude:.4f}-{longitude:.4f}"
    point = {"id": cache_key, "latitude": latitude, "longitude": longitude}
    response = await fetch_weather(request, point, refresh)
    return {
        **response,
        "location": {"latitude": latitude, "longitude": longitude},
        "label": "Selected map location",
    }


@app.get("/api/weather/{city_id}")
async def weather(city_id: str, request: Request, refresh: bool = False) -> dict[str, object]:
    city = CITY_BY_ID.get(city_id)
    if not city:
        raise HTTPException(status_code=404, detail="Unknown city identifier.")
    return await fetch_weather(request, city, refresh)


@app.get("/api/historical")
async def historical(
    request: Request,
    city: str = Query(min_length=1),
    start: date = Query(default=date(1990, 1, 1)),
    end: date = Query(default=date(2022, 12, 7)),
) -> dict[str, object]:
    if end < start:
        raise HTTPException(status_code=422, detail="end must be on or after start.")
    city_entry = CITY_BY_ID.get(city) or CITY_BY_DATA_NAME.get(city)
    if not city_entry:
        raise HTTPException(status_code=404, detail="Unknown city identifier.")
    records = request.app.state.historical.get(str(city_entry["dataName"]), [])
    selected_rows = [row for row in records if start <= row["date"] <= end]
    return {
        "city": city_entry["id"],
        "start": start.isoformat(),
        "end": end.isoformat(),
        "coverageStart": records[0]["date"].isoformat() if records else None,
        "coverageEnd": records[-1]["date"].isoformat() if records else None,
        "precipitationAvailable": False,
        "rows": [{key: row[key] for key in ("maximumC", "minimumC", "precipitationMm")} | {"date": row["date"].isoformat()} for row in selected_rows],
    }


@app.get("/api/historical/summary")
async def historical_summary(
    request: Request,
    city: str = Query(default="all", min_length=1),
    start: date = Query(default=date(1990, 1, 1)),
    end: date = Query(default=date(2022, 12, 7)),
) -> dict[str, object]:
    if end < start:
        raise HTTPException(status_code=422, detail="end must be on or after start.")
    city_entry = None if city == "all" else CITY_BY_ID.get(city) or CITY_BY_DATA_NAME.get(city)
    if city != "all" and not city_entry:
        raise HTTPException(status_code=404, detail="Unknown city identifier.")
    historical_data: dict[str, list[dict[str, object]]] = request.app.state.historical
    selected_names = [str(city_entry["dataName"])] if city_entry else list(historical_data)
    grouped_rows = {
        name: [row for row in historical_data.get(name, []) if start <= row["date"] <= end]
        for name in selected_names
    }
    selected_rows = [
        {**row, "dataCity": name}
        for name, city_rows in grouped_rows.items()
        for row in city_rows
    ]
    yearly: dict[int, list[float]] = {}
    monthly: dict[int, list[float]] = {}
    for row in grouped_rows.get(str(city_entry["dataName"]), []) if city_entry else []:
        observed_date = row["date"]
        yearly.setdefault(observed_date.year, []).append(float(row["maximumC"]))
        monthly.setdefault(observed_date.month, []).append(float(row["maximumC"]))
    comparisons = []
    for name, city_rows in grouped_rows.items():
        if not city_rows:
            continue
        city_info = CITY_BY_DATA_NAME.get(name)
        comparisons.append({
            "city": str(city_info["name"]) if city_info else name,
            "meanMaximumC": statistics.fmean(float(row["maximumC"]) for row in city_rows),
            "days": len(city_rows),
        })
    extreme_rows = sorted(selected_rows, key=lambda row: float(row["maximumC"]), reverse=True)[:10]
    month_names = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    return {
        "city": city_entry["id"] if city_entry else "all",
        "start": start.isoformat(),
        "end": end.isoformat(),
        "monthlyProfile": [
            {"month": month_names[month - 1], "monthNumber": month, "meanMaximumC": statistics.fmean(values)}
            for month, values in sorted(monthly.items())
        ],
        "yearlyMeans": [
            {"year": year, "meanMaximumC": statistics.fmean(values)}
            for year, values in sorted(yearly.items())
        ],
        "cityComparison": sorted(comparisons, key=lambda row: row["meanMaximumC"], reverse=True),
        "extremeDays": [
            {"date": row["date"].isoformat(), "city": str(CITY_BY_DATA_NAME.get(str(row["dataCity"]), {}).get("name", row["dataCity"])), "maximumC": row["maximumC"]}
            for row in extreme_rows
        ],
        "precipitationAvailable": False,
    }


@app.get("/api/model-metrics")
async def model_metrics(request: Request) -> dict[str, list[dict[str, object]]]:
    return request.app.state.metrics


@app.get("/api/model-metrics.csv")
async def model_metrics_csv(request: Request) -> Response:
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["metric_group", "model", "horizon_days", "mae_c", "rmse_c", "r2", "precision", "recall", "f1", "false_alarms", "missed_events", "interval_radius_c", "mean_width_c", "test_coverage_percent"])
    metrics = request.app.state.metrics
    for row in metrics["forecasting"]:
        writer.writerow(["forecasting", row["Model"], row["Horizon_days"], row["MAE_C"], row["RMSE_C"], row["R2"], "", "", "", "", "", "", "", ""])
    for row in metrics["classifiers"]:
        writer.writerow(["classifier", "", row["Horizon_days"], "", "", "", row["Precision"], row["Recall"], row["F1"], row["False_alarms"], row["Missed_extreme_days"], "", "", ""])
    for row in metrics["uncertainty"]:
        writer.writerow(["uncertainty", "", row["Horizon_days"], "", "", "", "", "", "", "", "", row["Interval_radius_C"], row["Mean_width_C"], row["Test_coverage_percent"]])
    return Response(content=output.getvalue(), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=heatshield-model-metrics.csv"})


@app.get("/api/drift")
async def drift(request: Request) -> dict[str, list[dict[str, object]]]:
    return {"rows": request.app.state.drift}

def latest_historical_window(
    request: Request,
    city: dict[str, object],
    as_of_date: date | None = None,
) -> tuple[list[date], list[list[float]]] | None:
    records = request.app.state.historical.get(str(city["dataName"]), [])
    eligible = [index for index, row in enumerate(records) if as_of_date is None or row["date"] <= as_of_date]
    for end_index in reversed(eligible):
        start_index = end_index - LOOKBACK_DAYS + 1
        if start_index < 0:
            continue
        window = records[start_index : end_index + 1]
        if len(window) != LOOKBACK_DAYS or any(right["date"] != left["date"] + timedelta(days=1) for left, right in zip(window, window[1:])):
            continue
        if as_of_date is not None and window[-1]["date"] != as_of_date:
            return None
        try:
            config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
            city_index = config["cities"].index(str(city["dataName"]))
            city_count = len(config["cities"])
        except (ValueError, KeyError, TypeError) as error:
            raise HTTPException(status_code=503, detail="City encoding does not match the validated feature contract.") from error
        sequence = []
        for row in window:
            city_encoding = [1.0 if index == city_index else 0.0 for index in range(city_count)]
            sequence.append([float(row["maximumC"]), float(row["daySin"]), float(row["dayCos"]), *city_encoding])
        return [row["date"] for row in window], sequence
    return None


def predict_classifier_probabilities(
    model_state: dict[str, object], sequence: list[list[float]]
) -> dict[int, float]:
    import numpy as np

    values = np.asarray(sequence, dtype=np.float32)
    scaler = model_state["scaler"]
    values[:, int(model_state["target_feature_index"])] = scaler.transform(
        values[:, int(model_state["target_feature_index"])].reshape(-1, 1)
    ).reshape(-1)
    values = values.reshape(1, LOOKBACK_DAYS, FEATURE_COUNT)
    models = model_state["models"]
    probabilities = {}
    for horizon in (1, 3, 7):
        prediction = np.asarray(models[f"classifier_{horizon}"].predict(values, verbose=0)).reshape(-1)
        if prediction.size != 1 or not np.isfinite(prediction[0]):
            raise HTTPException(status_code=503, detail="Classifier returned an invalid probability.")
        probabilities[horizon] = float(prediction[0])
    return probabilities


@app.get("/api/risk-comparison")
async def risk_comparison(request: Request) -> dict[str, object]:
    model_state = request.app.state.model_state
    if not model_state.get("loaded"):
        raise HTTPException(status_code=503, detail="Trained model artifacts are unavailable.")
    config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    thresholds = {int(key): float(value) for key, value in config.get("alert_thresholds", {}).items()}
    rows = []
    for city in CITIES:
        window = latest_historical_window(request, city)
        if window is None:
            continue
        input_dates, sequence = window
        probabilities = predict_classifier_probabilities(model_state, sequence)
        rows.append({
            "city": city["id"],
            "name": city["name"],
            "inputEndDate": input_dates[-1].isoformat(),
            "horizons": [
                {"horizonDays": horizon, "probability": probabilities[horizon], "alertThreshold": thresholds[horizon], "modelAlert": probabilities[horizon] >= thresholds[horizon]}
                for horizon in (1, 3, 7)
            ],
        })
    return {"sourceMode": "historical_demo", "experimental": True, "rows": rows}



def run_inference(
    request: Request,
    city: dict[str, object],
    input_dates: list[date],
    input_sequence: list[list[float]],
    feature_order: list[str],
    source_mode: str,
    source_timestamp: datetime | None,
) -> PredictionResponse:
    model_state = request.app.state.model_state
    target_index = model_state.get("target_feature_index")
    if not model_state.get("loaded"):
        raise HTTPException(status_code=503, detail="Trained model runtime is unavailable; no prediction was generated.")
    expected_order = model_state.get("feature_order")
    if not isinstance(expected_order, list) or len(expected_order) != FEATURE_COUNT or not isinstance(target_index, int):
        raise HTTPException(status_code=503, detail="Inference is disabled because the saved feature contract is unavailable.")
    if feature_order != expected_order:
        raise HTTPException(status_code=422, detail="feature_order does not match the validated model preprocessing contract.")

    try:
        import numpy as np

        scaler = model_state["scaler"]
        if scaler.n_features_in_ != 1 or not 0 <= target_index < FEATURE_COUNT:
            raise ValueError("scaler width or target index does not match model input")
        values = np.asarray(input_sequence, dtype=np.float32)
        if values.shape != (LOOKBACK_DAYS, FEATURE_COUNT) or not np.isfinite(values).all():
            raise ValueError("input must be a finite 30 by 10 feature matrix")
        scaled = values.copy()
        scaled[:, target_index] = scaler.transform(values[:, target_index].reshape(-1, 1)).reshape(-1)
        scaled = scaled.reshape(1, LOOKBACK_DAYS, FEATURE_COUNT)
        models = model_state["models"]
        lstm_output = np.asarray(models["lstm"].predict(scaled, verbose=0)).reshape(-1)
        if lstm_output.size != 3 or not np.isfinite(lstm_output).all():
            raise ValueError("unexpected forecast output width")
        temperatures = scaler.inverse_transform(lstm_output.reshape(-1, 1)).reshape(-1)
        metrics = request.app.state.metrics
        uncertainties = {row["Horizon_days"]: row for row in metrics["uncertainty"]}
        classifier_outputs = {}
        for horizon in (1, 3, 7):
            output = np.asarray(models[f"classifier_{horizon}"].predict(scaled, verbose=0)).reshape(-1)
            if output.size != 1 or not np.isfinite(output[0]):
                raise ValueError("unexpected classifier output width")
            classifier_outputs[horizon] = float(output[0])
        config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
        thresholds = config.get("alert_thresholds", {})
        generated_at = datetime.now(timezone.utc)
        forecasts = []
        for index, horizon in enumerate((1, 3, 7)):
            probability = classifier_outputs[horizon]
            threshold = float(thresholds[str(horizon)])
            radius = float(uncertainties[horizon]["Interval_radius_C"])
            forecast_date = input_dates[-1] + timedelta(days=horizon)
            forecasts.append(PredictionHorizon(
                horizon_days=horizon,
                target_date=forecast_date,
                predicted_max_c=float(temperatures[index]),
                lower_c=float(temperatures[index] - radius),
                upper_c=float(temperatures[index] + radius),
                heat_probability=probability,
                alert_threshold=threshold,
                model_alert=probability >= threshold,
            ))
        return PredictionResponse(city=str(city["id"]), source_mode=source_mode, source_timestamp=source_timestamp, input_end_date=input_dates[-1], generated_at=generated_at, forecasts=forecasts)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"Prediction could not be produced from the supplied sequence: {type(error).__name__}.") from error


@app.post("/api/predict", response_model=PredictionResponse)
async def predict(payload: PredictionRequest, request: Request) -> PredictionResponse:
    city = CITY_BY_ID.get(payload.city) or CITY_BY_DATA_NAME.get(payload.city)
    if not city:
        raise HTTPException(status_code=404, detail="Unknown city identifier.")
    if payload.source_mode == "live":
        raise HTTPException(status_code=503, detail="Live inference is disabled: the Open-Meteo input path has not been independently validated. Use historical demo mode.")
    return run_inference(request, city, payload.input_dates, payload.input_sequence, payload.feature_order, "historical", payload.source_timestamp)


@app.post("/api/predict/historical", response_model=PredictionResponse)
async def predict_historical(payload: HistoricalDemoRequest, request: Request) -> PredictionResponse:
    city = CITY_BY_ID.get(payload.city) or CITY_BY_DATA_NAME.get(payload.city)
    if not city:
        raise HTTPException(status_code=404, detail="Unknown city identifier.")
    model_state = request.app.state.model_state
    feature_order = model_state.get("feature_order")
    if not model_state.get("loaded") or not isinstance(feature_order, list):
        raise HTTPException(status_code=503, detail="Trained model artifacts are unavailable; no demo prediction was generated.")
    records = request.app.state.historical.get(str(city["dataName"]), [])
    eligible = [index for index, row in enumerate(records) if payload.as_of_date is None or row["date"] <= payload.as_of_date]
    for end_index in reversed(eligible):
        start_index = end_index - LOOKBACK_DAYS + 1
        if start_index < 0:
            continue
        window = records[start_index : end_index + 1]
        if len(window) != LOOKBACK_DAYS or any(right["date"] != left["date"] + timedelta(days=1) for left, right in zip(window, window[1:])):
            continue
        if payload.as_of_date is not None and window[-1]["date"] != payload.as_of_date:
            raise HTTPException(status_code=422, detail="No complete 30-day historical input window ends on the requested date.")
        try:
            import numpy as np

            config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
            city_names = config["cities"]
            city_index = city_names.index(str(city["dataName"]))
        except (ValueError, KeyError, TypeError) as error:
            raise HTTPException(status_code=503, detail="City encoding does not match the validated feature contract.") from error
        sequence = []
        for row in window:
            city_encoding = [1.0 if index == city_index else 0.0 for index in range(len(city_names))]
            sequence.append([float(row["maximumC"]), float(row["daySin"]), float(row["dayCos"]), *city_encoding])
        source_timestamp = datetime.combine(window[-1]["date"], datetime.min.time(), tzinfo=timezone(timedelta(hours=5, minutes=30)))
        return run_inference(request, city, [row["date"] for row in window], sequence, feature_order, "historical_demo", source_timestamp)
    raise HTTPException(status_code=422, detail="No complete 30-day historical input window is available for this city.")


if os.getenv("HEATSHIELD_DEBUG") == "1":
    app.debug = True


# In production (and in local single-process launches), serve the Vite build
# from the API process so the dashboard does not depend on a second listener.
DIST = ROOT / "dist"
ASSETS = DIST / "assets"
if ASSETS.is_dir():
    app.mount("/assets", StaticFiles(directory=ASSETS), name="assets")

    @app.get("/india-states.geojson", include_in_schema=False)
    async def india_states() -> FileResponse:
        return FileResponse(DIST / "india-states.geojson", media_type="application/geo+json")

    @app.get("/", include_in_schema=False)
    async def dashboard() -> FileResponse:
        return FileResponse(DIST / "index.html")
