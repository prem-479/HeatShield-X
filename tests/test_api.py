from __future__ import annotations

from datetime import date, timedelta
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import server


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as test_client:
        yield test_client


def valid_prediction_body() -> dict[str, object]:
    first_day = date(2022, 1, 1)
    config = json.loads((Path(server.__file__).resolve().parent / "config.json").read_text())
    return {
        "city": "bangalore",
        "input_dates": [(first_day + timedelta(days=index)).isoformat() for index in range(30)],
        "input_sequence": [[float(index + feature) for feature in range(10)] for index in range(30)],
        "feature_order": config["feature_order"],
        "source_mode": "historical",
        "source_timestamp": "2022-01-30T12:00:00Z",
    }


def test_city_locations_and_health_are_reported(client: TestClient) -> None:
    cities_response = client.get("/api/cities")
    health_response = client.get("/api/health")

    assert cities_response.status_code == 200
    assert len(cities_response.json()["cities"]) == 7
    delhi = next(city for city in cities_response.json()["cities"] if city["id"] == "delhi-ncr")
    assert delhi["latitude"] == pytest.approx(28.6139)
    assert health_response.status_code == 200
    assert health_response.json()["model_artifacts_loaded"] is True
    assert health_response.json()["historical_demo_enabled"] is True
    assert health_response.json()["live_model_inference_enabled"] is False


def test_historical_records_are_loaded_from_supplied_csv(client: TestClient) -> None:
    response = client.get("/api/historical", params={"city": "bangalore", "start": "1990-01-01", "end": "1990-01-03"})

    assert response.status_code == 200
    body = response.json()
    assert [row["date"] for row in body["rows"]] == ["1990-01-01", "1990-01-02", "1990-01-03"]
    assert body["rows"][0]["maximumC"] == 28.4
    assert body["rows"][0]["minimumC"] is None
    assert body["precipitationAvailable"] is False


def test_historical_date_range_must_be_ordered(client: TestClient) -> None:
    response = client.get("/api/historical", params={"city": "bangalore", "start": "2020-01-02", "end": "2020-01-01"})

    assert response.status_code == 422


def test_historical_summary_is_derived_from_observations(client: TestClient) -> None:
    response = client.get("/api/historical/summary", params={"city": "bangalore", "start": "2020-01-01", "end": "2020-01-31"})

    assert response.status_code == 200
    body = response.json()
    assert body["yearlyMeans"][0]["year"] == 2020
    assert body["monthlyProfile"][0]["month"] == "Jan"
    assert body["extremeDays"][0]["city"] == "Bengaluru"
    assert body["precipitationAvailable"] is False


def test_prediction_rejects_out_of_order_dates(client: TestClient) -> None:
    body = valid_prediction_body()
    body["input_dates"][4] = body["input_dates"][3]

    response = client.post("/api/predict", json=body)

    assert response.status_code == 422
    assert "strictly increasing" in response.text


def test_prediction_rejects_wrong_feature_width(client: TestClient) -> None:
    body = valid_prediction_body()
    body["input_sequence"][0] = [1.0] * 9

    response = client.post("/api/predict", json=body)

    assert response.status_code == 422
    assert "exactly 10 features" in response.text


def test_prediction_rejects_missing_inputs(client: TestClient) -> None:
    response = client.post("/api/predict", json={"city": "bangalore"})

    assert response.status_code == 422


def test_live_prediction_is_blocked_until_live_pipeline_is_validated(client: TestClient) -> None:
    body = valid_prediction_body()
    body["source_mode"] = "live"
    response = client.post("/api/predict", json=body)

    assert response.status_code == 503
    assert "Live inference is disabled" in response.text


def test_historical_demo_uses_trained_models_and_returns_three_horizons(client: TestClient) -> None:
    response = client.post("/api/predict/historical", json={"city": "bangalore"})

    assert response.status_code == 200
    body = response.json()
    assert body["source_mode"] == "historical_demo"
    assert body["experimental"] is True
    assert len(body["forecasts"]) == 3
    assert [row["horizon_days"] for row in body["forecasts"]] == [1, 3, 7]
    assert all(row["lower_c"] < row["predicted_max_c"] < row["upper_c"] for row in body["forecasts"])


def test_artifact_metrics_are_returned(client: TestClient) -> None:
    response = client.get("/api/model-metrics")
    body = response.json()

    assert response.status_code == 200
    assert body["forecasting"][0]["MAE_C"] == pytest.approx(1.358129978)
    assert len(body["uncertainty"]) == 3
    assert body["classifiers"][0]["False_alarms"] == 460


def test_model_metrics_can_be_downloaded_as_csv(client: TestClient) -> None:
    response = client.get("/api/model-metrics.csv")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "Fine-tuned LSTM" in response.text


def test_risk_comparison_uses_historical_windows_for_all_cities(client: TestClient) -> None:
    response = client.get("/api/risk-comparison")

    assert response.status_code == 200
    body = response.json()
    assert body["sourceMode"] == "historical_demo"
    assert body["experimental"] is True
    assert len(body["rows"]) == 7
    assert all(len(row["horizons"]) == 3 for row in body["rows"])
    assert all("inputEndDate" in row for row in body["rows"])


def test_weather_response_is_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {
                "timezone": "Asia/Kolkata",
                "current": {"temperature_2m": 31.0, "apparent_temperature": 33.0, "wind_speed_10m": 9.0},
                "daily": {"time": ["2026-10-21"], "temperature_2m_max": [34.0], "temperature_2m_min": [25.0], "precipitation_sum": [0.0]},
            }

    class FakeClient:
        calls = 0

        def __init__(self, *args: object, **kwargs: object) -> None:
            return None

        async def __aenter__(self) -> FakeClient:
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def get(self, *args: object, **kwargs: object) -> FakeResponse:
            type(self).calls += 1
            return FakeResponse()

    monkeypatch.setattr(server.httpx, "AsyncClient", FakeClient)
    with TestClient(server.app) as client:
        live = client.get("/api/weather/bangalore")
        cached = client.get("/api/weather/bangalore")

    assert live.status_code == 200
    assert live.json()["source"] == "live"
    assert live.json()["daily"][0]["maximumC"] == 34.0
    assert cached.json()["source"] == "cached"
    assert FakeClient.calls == 1