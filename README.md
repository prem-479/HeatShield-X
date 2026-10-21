# HeatShield-X

HeatShield-X is an experimental climate-intelligence dashboard for seven Indian cities. It separates live Open-Meteo forecasts from historical observations and historical model evaluation. Model-generated heat-risk outputs are not treated as official warnings.

## Requirements

- Python 3.11 or 3.13
- Node.js 20.19+ and npm
- Network access for Open-Meteo weather and OpenFreeMap tiles

## Local development

Create a Python environment and install the API dependencies:

```bash
python3.13 -m venv .venv-heatshield
source .venv-heatshield/bin/activate
python -m pip install -r requirements.txt
```

In one terminal, start the API from the project root:

```bash
uvicorn server:app --reload --host 127.0.0.1 --port 8000
```

In another terminal, install and run the frontend:

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. The Vite development server proxies `/api` to `127.0.0.1:8000`. The API health endpoint is `/api/health`; interactive API documentation is at `/docs`.

## Data and model behavior

- The seven city coordinates and heat-threshold proximity bands are explicit application configuration. Bands are experimental context, not official IMD heatwave classifications.
- Live daily maximum/minimum temperatures, precipitation, current temperature, apparent temperature, and wind are fetched from Open-Meteo. Successful responses are cached for 15 minutes; the last successful response is returned as `cached` if a refresh fails. Open-Meteo attribution is shown in the UI. Review the provider's current terms before commercial deployment.
- Historical records are loaded once from `cleaned_city_weather.csv`. The supplied CSV contains date, city, maximum temperature, and seasonal encodings only. Minimum temperature and precipitation are not present and are not estimated. Dataset records cover 1990 through 2022.
- Offline metrics and drift results are read from the supplied CSV artifacts. Regression R² is not presented as accuracy. Classifier evaluation shows its false-alarm burden.
- The supplied Keras models require 30 time steps and 10 features. The verified feature order in `config.json` is scaled maximum temperature, `day_sin`, `day_cos`, and seven one-hot city indicators. Rebuilding complete held-out windows from 2020–2022 reproduces the saved LSTM MAE/RMSE and classifier precision/recall/F1/false-alarm/missed-event metrics. `/api/predict/historical` runs the trained artifacts on a historical demo window. `/api/predict` rejects `source_mode: "live"` because the live weather input path has not been independently validated; do not interpret historical demo output as current live forecasting skill.
- The API attempts to load the supplied artifacts once at startup. `/api/health` reports model loading and inference readiness without exposing filesystem paths. Missing or incompatible artifacts leave the rest of the application usable and return a clear model status.

## Tests

Run API and data-contract tests:

```bash
pytest -q
```

The tests cover city coordinates, historical row parsing and range ordering, weather cache behavior, prediction dates and feature shape, missing prediction fields, metrics, and the explicit unavailable-inference response.

## Production build and deployment

Build the frontend and serve it with a static host or reverse proxy:

```bash
npm ci
npm run build
```

Run the API with a production ASGI server:

```bash
uvicorn server:app --host 0.0.0.0 --port 8000 --workers 1
```

Keep the supplied model artifacts and CSVs on the backend host. Configure the frontend host/reverse proxy to route `/api/*` to the API service. The TensorFlow runtime can be memory-intensive; one worker avoids loading a separate copy of each model per worker. Do not enable debug mode in production.

## Attribution

Weather: [Open-Meteo](https://open-meteo.com/). Map tiles: [OpenFreeMap](https://openfreemap.org/) using OpenStreetMap contributors' data. Check both providers' current attribution and usage terms before deployment.
