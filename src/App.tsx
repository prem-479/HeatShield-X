import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
} from "maplibre-gl";
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  CloudSun,
  Compass,
  Database,
  Gauge,
  MapPin,
  Menu,
  RefreshCw,
  Thermometer,
  Waves,
  Wind,
  X,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type City = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  heatThresholdC: number;
};
type Day = {
  date: string;
  maximumC: number | null;
  minimumC: number | null;
  precipitationMm: number | null;
};
type Weather = {
  city: string;
  source: "live" | "cached" | "unavailable";
  fetchedAt: string | null;
  daily: Day[];
  current: {
    temperatureC: number | null;
    apparentTemperatureC: number | null;
    windSpeedKmh: number | null;
  } | null;
};
type HistoryRow = { date: string; maximumC: number; minimumC: number | null };
type HistoricalSummary = {
  monthlyProfile: Array<{ month: string; meanMaximumC: number }>;
  yearlyMeans: Array<{ year: number; meanMaximumC: number }>;
  cityComparison: Array<{ city: string; meanMaximumC: number; days: number }>;
  extremeDays: Array<{ date: string; city: string; maximumC: number }>;
  precipitationAvailable: boolean;
};
type DemoResult = {
  city: string;
  source_mode: string;
  input_end_date: string;
  interval_method: string;
  forecasts: Array<{
    horizon_days: number;
    target_date: string;
    predicted_max_c: number;
    lower_c: number;
    upper_c: number;
    heat_probability: number;
    alert_threshold: number;
    model_alert: boolean;
  }>;
};
type RiskComparisonRow = {
  city: string;
  name: string;
  inputEndDate: string;
  horizons: Array<{
    horizonDays: number;
    probability: number;
    alertThreshold: number;
    modelAlert: boolean;
  }>;
};
type Metrics = {
  forecasting: Array<Record<string, string | number>>;
  classifiers: Array<Record<string, string | number>>;
  uncertainty: Array<Record<string, string | number>>;
};
type DriftRow = {
  city: string;
  horizonDays: number;
  samples: number;
  maeC: number;
  detections: number;
  firstDetection: string | null;
};
type Page =
  "overview"
  | "risk"
  | "history"
  | "performance"
  | "uncertainty"
  | "drift"
  | "about";

const fallbackCities: City[] = [
  {
    id: "bangalore",
    name: "Bengaluru",
    latitude: 12.9716,
    longitude: 77.5946,
    heatThresholdC: 35.2,
  },
  {
    id: "bhubaneswar",
    name: "Bhubaneswar",
    latitude: 20.2961,
    longitude: 85.8245,
    heatThresholdC: 39.6,
  },
  {
    id: "chennai",
    name: "Chennai",
    latitude: 13.0827,
    longitude: 80.2707,
    heatThresholdC: 39.4,
  },
  {
    id: "delhi-ncr",
    name: "Delhi NCR",
    latitude: 28.6139,
    longitude: 77.209,
    heatThresholdC: 41.7,
  },
  {
    id: "jodhpur",
    name: "Jodhpur",
    latitude: 26.2389,
    longitude: 73.0243,
    heatThresholdC: 35.2,
  },
  {
    id: "lucknow",
    name: "Lucknow",
    latitude: 26.8467,
    longitude: 80.9462,
    heatThresholdC: 42.1,
  },
  {
    id: "mumbai",
    name: "Mumbai",
    latitude: 19.076,
    longitude: 72.8777,
    heatThresholdC: 35.6,
  },
];
const API = "/api";
// West, south, east, north: a country-level view with enough padding for all
// seven supported locations, without starting on a broad Asia-wide viewport.
const INDIA_BOUNDS: [[number, number], [number, number]] = [
  [68.0, 6.0],
  [97.5, 37.5],
];
const nav = [
  ["overview", "Overview", Activity],
  ["overview", "Live weather", CloudSun],
  ["overview", "Temperature forecasts", Thermometer],
  ["risk", "Heat risk map", MapPin],
  ["history", "Historical trends", Waves],
  ["performance", "Model performance", Gauge],
  ["uncertainty", "Uncertainty & confidence", CircleHelp],
  ["drift", "Drift monitoring", Activity],
  ["about", "About the project", Database],
] as const;

function band(value: number | null | undefined, threshold: number) {
  if (value == null) return "unavailable";
  return value >= threshold
    ? "elevated"
    : value >= threshold * 0.9
      ? "watch"
      : "baseline";
}
function timeLabel(value: string | null | undefined) {
  return value
    ? new Intl.DateTimeFormat("en-IN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "Not fetched yet";
}

export default function App() {
  const [cities, setCities] = useState(fallbackCities);
  const [selected, setSelected] = useState("delhi-ncr");
  const [page, setPage] = useState<Page>("overview");
  const [weather, setWeather] = useState<Record<string, Weather>>({});
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [drift, setDrift] = useState<DriftRow[]>([]);
    const [riskRows, setRiskRows] = useState<RiskComparisonRow[]>([]);
    const [riskLoading, setRiskLoading] = useState(false);
    const [riskError, setRiskError] = useState("");
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [historicalSummary, setHistoricalSummary] =
    useState<HistoricalSummary | null>(null);
  const [weatherBusy, setWeatherBusy] = useState(false);
  const [weatherError, setWeatherError] = useState("");
  const [sidebar, setSidebar] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [historyCity, setHistoryCity] = useState("delhi_ncr");
  const [from, setFrom] = useState("2018-01-01");
  const [to, setTo] = useState("2022-12-07");
  const [activeNav, setActiveNav] = useState("Overview");
  const [demoOpen, setDemoOpen] = useState(false);
  const mapElement = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<Record<string, Marker>>({});
  const city = cities.find((item) => item.id === selected) ?? fallbackCities[3];
  const active = weather[selected];

  async function loadWeather(id: string, refresh = false) {
    setWeatherBusy(true);
    setWeatherError("");
    try {
      const response = await fetch(
        `${API}/weather/${encodeURIComponent(id)}${refresh ? "?refresh=true" : ""}`,
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.detail ?? "Weather service is unavailable.");
      setWeather((current) => ({ ...current, [id]: result }));
      setWeatherError(result.message ?? "");
    } catch (error) {
      setWeatherError(
        error instanceof Error
          ? error.message
          : "Weather service is unavailable.",
      );
    } finally {
      setWeatherBusy(false);
    }
  }

  async function loadHistory() {
    const query = new URLSearchParams({
      city: historyCity,
      start: from,
      end: to,
    });
    try {
      const allCityQuery = new URLSearchParams({
        city: "all",
        start: from,
        end: to,
      });
      const [response, summaryResponse, comparisonResponse] = await Promise.all(
        [
          fetch(`${API}/historical?${query}`),
          fetch(`${API}/historical/summary?${query}`),
          fetch(`${API}/historical/summary?${allCityQuery}`),
        ],
      );
      const [result, summary, comparison] = await Promise.all([
        response.json(),
        summaryResponse.json(),
        comparisonResponse.json(),
      ]);
      setRows(response.ok ? (result.rows ?? []) : []);
      setHistoricalSummary(
        summaryResponse.ok && comparisonResponse.ok
          ? { ...summary, cityComparison: comparison.cityComparison }
          : null,
      );
    } catch {
      setRows([]);
      setHistoricalSummary(null);
    }
  }

  useEffect(() => {
    fetch(`${API}/cities`)
      .then((r) => (r.ok ? r.json() : null))
      .then((r) => r?.cities?.length && setCities(r.cities))
      .catch(() => undefined);
    fetch(`${API}/model-metrics`)
      .then((r) => (r.ok ? r.json() : null))
      .then((r) => r && setMetrics(r))
      .catch(() => undefined);
    fetch(`${API}/drift`)
      .then((r) => (r.ok ? r.json() : null))
      .then((r) => r && setDrift(r.rows ?? []))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (page !== "risk") return;
    let activeRequest = true;
    setRiskLoading(true);
    setRiskError("");
    fetch(`${API}/risk-comparison`)
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.detail ?? "Risk comparison is unavailable.");
        if (activeRequest) setRiskRows(result.rows ?? []);
      })
      .catch((error) => {
        if (activeRequest)
          setRiskError(
            error instanceof Error
              ? error.message
              : "Risk comparison is unavailable.",
          );
      })
      .finally(() => {
        if (activeRequest) setRiskLoading(false);
      });
    return () => {
      activeRequest = false;
    };
  }, [page]);
  useEffect(() => {
    // The map is a city comparison, so populate every supported marker rather
    // than showing a live value only for the currently selected location.
    let cancelled = false;
    const missing = cities.filter((item) => !weather[item.id]);
    if (!missing.length) return;
    void Promise.all(
      missing.map(async (item) => {
        try {
          const response = await fetch(`${API}/weather/${encodeURIComponent(item.id)}`);
          if (!response.ok) return null;
          return (await response.json()) as Weather;
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setWeather((current) => {
        const next = { ...current };
        results.forEach((result) => {
          if (result) next[result.city] = result;
        });
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // Weather responses are cached by the API; reload occurs only when the
    // city list changes or the user explicitly uses Refresh weather.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cities]);
  useEffect(() => {
    if (page === "history") void loadHistory();
  }, [page, historyCity, from, to]);

  useEffect(() => {
    if (page !== "overview" || !mapElement.current) return;
    if (map.current) map.current.remove();
    const instance = new MapLibreMap({
      container: mapElement.current,
      // Direct OpenStreetMap raster tiles; no vector style, sprites, or API key.
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
        },
        layers: [
          {
            id: "osm-raster",
            type: "raster",
            source: "osm",
          },
        ],
      },
      bounds: INDIA_BOUNDS,
      fitBoundsOptions: { padding: 42 },
      pitch: 32,
      bearing: 0,
      maxPitch: 65,
    });
    instance.addControl(
      new NavigationControl({ visualizePitch: true }),
      "top-right",
    );
    instance.on("click", (event) => {
      const latitude = event.lngLat.lat;
      const longitude = event.lngLat.lng;
      const popup = new Popup({ offset: 14, closeButton: true })
        .setLngLat(event.lngLat)
        .setHTML(
          `<div class="popup"><b>Selected map location</b><span>${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°</span><small>Loading live Open-Meteo weather…</small></div>`,
        )
        .addTo(instance);
      void fetch(
        `${API}/weather/coordinates?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}`,
      )
        .then(async (response) => {
          const result = await response.json();
          if (!response.ok) throw new Error(result.detail ?? "Live weather is unavailable.");
          const tomorrow = result.daily?.[1];
          const current = result.current?.temperatureC;
          popup.setHTML(
            `<div class="popup"><b>Selected map location</b><span>${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°</span><span>${current == null ? "Current temperature unavailable" : `${Number(current).toFixed(1)}°C now`}</span><small>${tomorrow?.maximumC == null ? "Next-day maximum unavailable" : `Next-day maximum: ${Number(tomorrow.maximumC).toFixed(1)}°C`}</small><small>Source: ${result.source} · ${timeLabel(result.fetchedAt)}</small></div>`,
          );
        })
        .catch((error) => {
          popup.setHTML(
            `<div class="popup"><b>Selected map location</b><span>${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°</span><small>${error instanceof Error ? error.message : "Live weather is unavailable."}</small></div>`,
          );
        });
    });
    instance.on("load", () => {
      const before = instance
        .getStyle()
        .layers?.find(
          (layer) => layer.type === "symbol" && layer.layout?.["text-field"],
        )?.id;
      try {
        instance.addSource("heatshield-india-states", {
          type: "geojson",
          data: "/india-states.geojson",
        });
        instance.addLayer(
          {
            id: "heatshield-state-fill",
            source: "heatshield-india-states",
            type: "fill",
            paint: {
              "fill-color": "#2d675d",
              "fill-opacity": 0.12,
            },
          },
          before,
        );
        instance.addLayer(
          {
            id: "heatshield-state-boundaries",
            source: "heatshield-india-states",
            type: "line",
            paint: {
              "line-color": "#87c4b5",
              "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.9, 7, 1.55],
              "line-opacity": 0.9,
            },
          },
          before,
        );
      } catch {
        /* Some public styles omit building-height tiles. */
      }
    });
    map.current = instance;
    return () => {
      instance.remove();
      if (map.current === instance) map.current = null;
      markers.current = {};
    };
  }, [page]);

  useEffect(() => {
    if (page !== "overview" || !map.current) return;
    Object.values(markers.current).forEach((marker) => marker.remove());
    markers.current = {};
    for (const item of cities) {
      const maximum = weather[item.id]?.daily[1]?.maximumC ?? null;
      const marker = document.createElement("button");
      marker.className = `city-marker marker-${band(maximum, item.heatThresholdC)}${selected === item.id ? " selected" : ""}`;
      marker.type = "button";
      marker.setAttribute("aria-label", `Select ${item.name}`);
      marker.innerHTML = "<i></i>";
      marker.addEventListener("click", () => chooseCity(item.id));
      const popup = `<div class="popup"><b>${item.name}</b><span>${maximum == null ? "Forecast unavailable" : `${maximum.toFixed(1)}°C forecast maximum`}</span><small>Fetched: ${timeLabel(weather[item.id]?.fetchedAt)}</small><small>Source: ${weather[item.id]?.source ?? "not fetched"}</small><small>Experimental threshold proximity · not an official warning</small></div>`;
      markers.current[item.id] = new Marker({ element: marker })
        .setLngLat([item.longitude, item.latitude])
        .setPopup(
          new Popup({ offset: 14, closeButton: false }).setHTML(
            popup,
          ),
        )
        .addTo(map.current);
    }
  }, [page, cities, selected, weather]);

  function chooseCity(id: string) {
    setSelected(id);
    const item = cities.find((entry) => entry.id === id);
    if (item)
      map.current?.flyTo({
        center: [item.longitude, item.latitude],
        zoom: 5.3,
        duration: 800,
      });
  }
  function exportCsv() {
    if (!rows.length) return;
    const csv = [
      "date,maximum_c,minimum_c",
      ...rows.map((row) => `${row.date},${row.maximumC},${row.minimumC ?? ""}`),
    ].join("\n");
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    anchor.download = `heatshield-${historyCity.toLowerCase()}-history.csv`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }
  function exportWeatherCsv() {
    const forecast = weather[selected];
    if (!forecast?.daily.length) return;
    const csv = [
      "source,fetched_at,date,maximum_c,minimum_c,precipitation_mm",
      ...forecast.daily.map(
        (day) =>
          `${forecast.source},${forecast.fetchedAt ?? ""},${day.date},${day.maximumC ?? ""},${day.minimumC ?? ""},${day.precipitationMm ?? ""}`,
      ),
    ].join("\n");
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    anchor.download = `heatshield-${selected}-open-meteo.csv`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }
  function openHistory() {
    setPage("history");
    setActiveNav("Historical trends");
  }
  function openDemo() {
    setPage("overview");
    setActiveNav("Temperature forecasts");
    setDemoOpen(true);
  }

  return (
    <div className="shell">
      {sidebar && (
        <button
          className="scrim"
          aria-label="Close navigation"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside
        className={`sidebar${collapsed ? " collapsed" : ""}${sidebar ? " open" : ""}`}
      >
        <div className="brand">
          <div className="mark">
            H<i />
          </div>
          {!collapsed && (
            <div>
              <b>
                HEATSHIELD<span>-X</span>
              </b>
              <small>CLIMATE INTELLIGENCE</small>
            </div>
          )}
          <button
            className="icon collapse"
            title="Collapse navigation"
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
          <button
            className="icon close"
            aria-label="Close navigation"
            onClick={() => setSidebar(false)}
          >
            <X size={18} />
          </button>
        </div>
        {!collapsed && <div className="nav-caption">WORKSPACE</div>}
        <nav>
          {nav.map(([target, label, Icon], index) => (
            <button
              key={`${label}-${index}`}
              title={collapsed ? label : undefined}
              className={`nav-item${activeNav === label ? " active" : ""}${index === 4 || index === 8 ? " gap" : ""}`}
              onClick={() => {
                setPage(target);
                setActiveNav(label);
                setSidebar(false);
              }}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        {!collapsed && (
          <div className="sidebar-status">
            <small>
              <i className={`dot ${active?.source ?? "unavailable"}`} /> WEATHER
              SOURCE
            </small>
            <b>
              {active?.source === "live"
                ? "Live Open-Meteo"
                : active?.source === "cached"
                  ? "Cached weather"
                  : "Source unavailable"}
            </b>
            <span>{timeLabel(active?.fetchedAt)}</span>
            <hr />
            <div>
              <i className="dot amber" /> Model inference <b>Experimental</b>
            </div>
          </div>
        )}
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="crumb">
            <button
              className="icon mobile-menu"
              aria-label="Open navigation"
              onClick={() => setSidebar(true)}
            >
              <Menu size={19} />
            </button>
            <span>HeatShield-X</span>
            <ChevronRight size={13} />
            <b>{activeNav}</b>
          </div>
          <div className="topbar-meta">
            <a
              className="download-link"
              href="/api/model-metrics.csv"
              title="Download model metrics as CSV"
            >
              <ArrowDownToLine size={14} />
              <span>Metrics CSV</span>
            </a>
            {page === "overview" && (
              <button
                className="download-link"
                disabled={!active?.daily.length}
                onClick={exportWeatherCsv}
                title="Download current Open-Meteo forecast as CSV"
              >
                <ArrowDownToLine size={14} />
                <span>Weather CSV</span>
              </button>
            )}
            <span className={`data-pill ${active?.source ?? "unavailable"}`}>
              <i className={`dot ${active?.source ?? "unavailable"}`} />
              {active?.source === "live"
                ? "Live data"
                : active?.source === "cached"
                  ? "Cached data"
                  : "Weather unavailable"}
            </span>
            <small>INDIA · IST</small>
          </div>
        </header>
        {page === "overview" ? (
          <>
            <Overview
              cities={cities}
              city={city}
              weather={weather}
              active={active}
              busy={weatherBusy}
              error={weatherError}
              refresh={() => void loadWeather(selected, true)}
              choose={chooseCity}
              mapElement={mapElement}
              map={map}
              openHistory={openHistory}
              openDemo={openDemo}
            />
            <ForecastTrend weather={active} />
            {demoOpen && (
              <HistoricalDemo cities={cities} defaultCity={selected} />
            )}
          </>
        ) : page === "history" ? (
          <>
            <HistoryPage
              cities={cities}
              city={historyCity}
              setCity={setHistoryCity}
              from={from}
              setFrom={setFrom}
              to={to}
              setTo={setTo}
              rows={rows}
              exportCsv={exportCsv}
            />
            <HistoryInsights summary={historicalSummary} />
          </>
        ) : page === "risk" ? (
          <RiskComparisonView rows={riskRows} loading={riskLoading} error={riskError} />
        ) : page === "performance" ? (
          <Performance metrics={metrics} />
        ) : page === "uncertainty" ? (
          <Uncertainty metrics={metrics} />
        ) : page === "drift" ? (
          <Drift rows={drift} />
        ) : (
          <About />
        )}
        <footer>
          <span>
            Weather:{" "}
            <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
              Open-Meteo
            </a>
          </span>
          <span>
            Map:{" "}
            <a href="https://openfreemap.org/" target="_blank" rel="noreferrer">
              OpenFreeMap
            </a>{" "}
            · © OpenStreetMap contributors
          </span>
          <span>Experimental outputs are not public-safety warnings.</span>
        </footer>
      </main>
    </div>
  );
}

function Metric({
  label,
  value,
  note,
  icon,
  amber = false,
}: {
  label: string;
  value: string;
  note: string;
  icon: ReactNode;
  amber?: boolean;
}) {
  return (
    <div className={`metric${amber ? " amber" : ""}`}>
      <div>
        <span>{label}</span>
        <i>{icon}</i>
      </div>
      <b>{value}</b>
      <small>{note}</small>
    </div>
  );
}

function ForecastTrend({ weather }: { weather?: Weather }) {
  const forecast = (weather?.daily ?? [])
    .slice(1, 8)
    .map((day) => ({
      ...day,
      label: new Intl.DateTimeFormat("en-IN", {
        weekday: "short",
        day: "numeric",
      }).format(new Date(`${day.date}T12:00:00`)),
    }));
  return (
    <div className="content secondary forecast-trend">
      <section className="panel">
        <div className="panel-head">
          <div>
            <small>OPEN-METEO · DAILY FORECAST · °C</small>
            <h2>Seven-day temperature outlook</h2>
          </div>
          <em className="tag">{weather?.source ?? "unavailable"}</em>
        </div>
        {forecast.length ? (
          <div className="trend-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={forecast}
                margin={{ top: 12, right: 14, bottom: 4, left: 0 }}
              >
                <CartesianGrid stroke="#2b3939" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "#87958f", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  unit="°C"
                  tick={{ fill: "#87958f", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                />
                <Tooltip
                  contentStyle={{
                    background: "#182324",
                    border: "1px solid #394748",
                    borderRadius: 3,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="maximumC"
                  name="Open-Meteo maximum"
                  stroke="#e7a954"
                  dot={{ r: 2 }}
                  strokeWidth={1.8}
                />
                <Line
                  type="monotone"
                  dataKey="minimumC"
                  name="Open-Meteo minimum"
                  stroke="#68b5a4"
                  dot={{ r: 2 }}
                  strokeWidth={1.5}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="empty">
            <CloudSun size={20} />
            Live forecast chart unavailable.
          </div>
        )}
        <p className="chart-caveat">
          Weather-provider forecasts only. LSTM predictions and intervals are
          omitted because live-input preprocessing is not validated.
        </p>
      </section>
    </div>
  );
}

function HistoricalDemo({
  cities,
  defaultCity,
}: {
  cities: City[];
  defaultCity: string;
}) {
  const [city, setCity] = useState(defaultCity);
  const [asOfDate, setAsOfDate] = useState("");
  const [result, setResult] = useState<DemoResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function runDemo() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch(`${API}/predict/historical`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          city,
          ...(asOfDate ? { as_of_date: asOfDate } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.detail ?? "Historical demo is unavailable.");
      setResult(body);
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : "Historical demo is unavailable.",
      );
    } finally {
      setBusy(false);
    }
  }
  function download() {
    if (!result) return;
    const columns = [
      "city",
      "source_mode",
      "input_end_date",
      "horizon_days",
      "target_date",
      "predicted_max_c",
      "lower_c",
      "upper_c",
      "heat_probability",
      "alert_threshold",
      "model_alert",
    ];
    const csv = [
      columns.join(","),
      ...result.forecasts.map((row) =>
        [
          result.city,
          result.source_mode,
          result.input_end_date,
          row.horizon_days,
          row.target_date,
          row.predicted_max_c,
          row.lower_c,
          row.upper_c,
          row.heat_probability,
          row.alert_threshold,
          row.model_alert,
        ].join(","),
      ),
    ].join("\n");
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    anchor.download = `heatshield-${city}-historical-demo.csv`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }
  return (
    <div className="content secondary demo-section">
      <section className="panel demo-panel">
        <div className="panel-head">
          <div>
            <small>HISTORICAL DEMO MODE · TRAINED ARTIFACTS</small>
            <h2>Experimental model outlook</h2>
          </div>
          <span className="demo-badge">HISTORICAL INPUT</span>
        </div>
        <div className="demo-controls">
          <label>
            City
            <select
              value={city}
              onChange={(event) => setCity(event.target.value)}
            >
              {cities.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Input through date
            <input
              type="date"
              min="1990-01-30"
              max="2022-12-07"
              value={asOfDate}
              onChange={(event) => setAsOfDate(event.target.value)}
            />
          </label>
          <button
            className="button"
            onClick={() => void runDemo()}
            disabled={busy}
          >
            <Activity size={15} />
            {busy ? "Running models…" : "Run historical demo"}
          </button>
          <button
            className="icon"
            title="Download historical demo forecasts as CSV"
            onClick={download}
            disabled={!result}
          >
            <ArrowDownToLine size={16} />
          </button>
        </div>
        {error && (
          <div className="demo-error" role="status">
            <AlertTriangle size={15} />
            {error}
          </div>
        )}
        {result && (
          <>
            <div className="demo-meta">
              <span>
                <i className="dot historical-dot" />
                Historical dataset
              </span>
              <span>30-day sequence through {result.input_end_date}</span>
              <span>Targets are retrospective forecasts</span>
            </div>
            <div className="demo-cards">
              {result.forecasts.map((forecast) => (
                <article className="demo-forecast" key={forecast.horizon_days}>
                  <div className="demo-card-head">
                    <small>
                      {forecast.horizon_days === 1
                        ? "TOMORROW"
                        : `${forecast.horizon_days} DAYS AHEAD`}
                    </small>
                    <span>{forecast.target_date}</span>
                  </div>
                  <strong>
                    {forecast.predicted_max_c.toFixed(1)}
                    <i>°C</i>
                  </strong>
                  <div className="interval-line">
                    <span>{forecast.lower_c.toFixed(1)}°</span>
                    <i />
                    <span>{forecast.upper_c.toFixed(1)}°</span>
                  </div>
                  <div className="demo-probability">
                    <span>Experimental heat probability</span>
                    <b>{(forecast.heat_probability * 100).toFixed(1)}%</b>
                  </div>
                  <div className="demo-alert-state">
                    <span>
                      Threshold {(forecast.alert_threshold * 100).toFixed(0)}%
                    </span>
                    <b className={forecast.model_alert ? "flagged" : ""}>
                      {forecast.model_alert ? "Model alert" : "Below threshold"}
                    </b>
                  </div>
                </article>
              ))}
            </div>
            <p className="demo-caveat">
              Historical demonstration only. Intervals use saved offline
              residuals; probabilities are experimental and are not official
              heatwave warnings or validated live predictions.
            </p>
          </>
        )}
      </section>
    </div>
  );
}

function RiskComparisonView({
  rows,
  loading,
  error,
}: {
  rows: RiskComparisonRow[];
  loading: boolean;
  error: string;
}) {
  const horizons = [1, 3, 7];
  return (
    <div className="content secondary">
      <div className="page-heading">
        <div>
          <div className="eyebrow"><i /> HISTORICAL DEMO · EXPERIMENTAL</div>
          <h1>Heat-risk comparison</h1>
          <p>
            Trained classifier probabilities on each city’s latest complete
            historical 30-day window—not live public-safety alerts.
          </p>
        </div>
        <em className="tag warn">historical demo</em>
      </div>
      {error ? (
        <div className="alert"><AlertTriangle size={16} />{error}</div>
      ) : loading ? (
        <section className="panel"><div className="empty">Loading historical model comparison…</div></section>
      ) : (
        <section className="panel table-panel">
          <div className="panel-head">
            <div>
              <small>MODEL-GENERATED PROBABILITY</small>
              <h2>Seven-city comparison</h2>
            </div>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>City</th>
                  <th>Input through</th>
                  {horizons.map((horizon) => <th key={horizon}>{horizon}-day probability</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.city}>
                    <td>{row.name}</td>
                    <td>{row.inputEndDate}</td>
                    {horizons.map((horizon) => {
                      const value = row.horizons.find((item) => item.horizonDays === horizon);
                      return (
                        <td key={horizon} className={value?.modelAlert ? "low" : ""}>
                          {value ? `${(value.probability * 100).toFixed(1)}%${value.modelAlert ? " · Model alert" : ""}` : "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length && <div className="empty">No complete historical input windows are available.</div>}
          <p>
            A model alert means its saved experimental threshold was crossed. It is not an official heatwave warning and has not been validated for live weather inputs.
          </p>
        </section>
      )}
    </div>
  );
}

function Overview({
  cities,
  city,
  weather,
  active,
  busy,
  error,
  refresh,
  choose,
  mapElement,
  map,
  openHistory,
  openDemo,
}: {
  cities: City[];
  city: City;
  weather: Record<string, Weather>;
  active?: Weather;
  busy: boolean;
  error: string;
  refresh: () => void;
  choose: (id: string) => void;
  mapElement: React.RefObject<HTMLDivElement | null>;
  map: React.RefObject<MapLibreMap | null>;
  openHistory: () => void;
  openDemo: () => void;
}) {
  const forecast = active?.daily.slice(1, 8) ?? [];
  const today = new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  })
    .format(new Date())
    .toUpperCase();
  return (
    <div className="content">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <i /> EXTREME HEAT INTELLIGENCE · {today}
          </div>
          <h1>City outlook</h1>
          <p>
            Weather conditions and experimental heat-threshold proximity across
            India.
          </p>
        </div>
        <button className="button" onClick={refresh} disabled={busy}>
          <RefreshCw size={15} className={busy ? "spin" : ""} />
          Refresh weather
        </button>
      </div>
      <section className="metrics">
        {[
          ["CITY", city.name, "Selected location", <MapPin size={16} />],
          [
            "CURRENT TEMPERATURE",
            active?.current?.temperatureC == null
              ? "—"
              : `${active.current.temperatureC.toFixed(1)}°`,
            active?.current?.apparentTemperatureC == null
              ? "Waiting for weather"
              : `Feels like ${active.current.apparentTemperatureC.toFixed(1)}°C`,
            <Thermometer size={16} />,
          ],
          [
            "NEXT DAILY MAX",
            forecast[0]?.maximumC == null
              ? "—"
              : `${forecast[0].maximumC.toFixed(1)}°`,
            forecast[0]?.date ?? "No forecast available",
            <CloudSun size={16} />,
          ],
          [
            "MODEL STATUS",
            "Experimental",
            "Live-input validation pending",
            <AlertTriangle size={16} />,
          ],
        ].map(([label, value, note, icon], index) => (
          <Metric
            key={String(label)}
            label={String(label)}
            value={String(value)}
            note={String(note)}
            icon={icon as ReactNode}
            amber={index === 3}
          />
        ))}
      </section>
      {error && (
        <div className="alert">
          <AlertTriangle size={16} />
          {error}
          {active?.source === "cached" &&
            " Showing the last successful cached response."}
        </div>
      )}
      <div className="columns">
        <section className="panel map-panel">
          <div className="panel-head">
            <div>
              <small>01 / GEOGRAPHIC VIEW</small>
              <h2>India heat outlook</h2>
            </div>
            <button
              className="icon"
              title="Reset map to India"
              onClick={() =>
                map.current?.fitBounds(INDIA_BOUNDS, {
                  padding: 42,
                  pitch: 32,
                  bearing: 0,
                  duration: 900,
                })
              }
            >
              <Compass size={17} />
            </button>
          </div>
          <div className="map-wrap">
            <div
              ref={mapElement}
              className="map-canvas"
              aria-label="Interactive map of supported Indian cities"
            />
            <div className="map-legend">
              <small>FORECAST THRESHOLD PROXIMITY</small>
              <span><i className="legend baseline" style={{ width: 12, height: 1, borderRadius: 0 }} /> State boundary</span>
              <span>
                <i className="legend baseline" />
                Baseline
              </span>
              <span>
                <i className="legend watch" />
                Watch
              </span>
              <span>
                <i className="legend elevated" />
                Elevated
              </span>
            </div>
            <div className="map-note">
              Click anywhere in India for live weather · experimental city markers are not official warnings
            </div>
          </div>
          <div className="city-list" aria-label="Select a city">
            {cities.map((item) => {
              const maximum = weather[item.id]?.daily[1]?.maximumC;
              return (
                <button
                  key={item.id}
                  className={city.id === item.id ? "selected" : ""}
                  onClick={() => choose(item.id)}
                >
                  <i
                    className={`city-dot ${band(maximum, item.heatThresholdC)}`}
                  />
                  <span>{item.name}</span>
                  <b>{maximum == null ? "—" : `${maximum.toFixed(0)}°`}</b>
                </button>
              );
            })}
          </div>
        </section>
        <section className="forecast-column">
          <div className="section-heading">
            <div>
              <small>02 / OUTLOOK</small>
              <h2>Temperature forecast</h2>
            </div>
            <span>OPEN-METEO · DAILY</span>
          </div>
          <div className="forecast-list">
            {forecast.map((day, index) => {
              const label =
                index === 0
                  ? "Tomorrow"
                  : new Intl.DateTimeFormat("en-IN", {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                    }).format(new Date(`${day.date}T12:00:00`));
              const level = band(day.maximumC, city.heatThresholdC);
              return (
                <div className={`forecast-row ${level}`} key={day.date}>
                  <span>{label}</span>
                  <i>
                    <b
                      style={{
                        width: `${day.maximumC == null ? 0 : Math.min(100, Math.max(4, (day.maximumC / 48) * 100))}%`,
                      }}
                    />
                  </i>
                  <strong>
                    {day.maximumC == null ? "—" : `${day.maximumC.toFixed(1)}°`}
                  </strong>
                  <small>
                    {day.minimumC == null ? "—" : `${day.minimumC.toFixed(1)}°`}
                  </small>
                  <em>{level}</em>
                </div>
              );
            })}
            {!forecast.length && (
              <div className="empty">
                {busy
                  ? "Loading forecast…"
                  : "Daily forecast appears when weather is available."}
              </div>
            )}
          </div>
          <div className="forecast-source">
            <i className={`dot ${active?.source ?? "unavailable"}`} />
            {active?.source ?? "unavailable"} · {timeLabel(active?.fetchedAt)}
          </div>
          <div className="model-alert">
            <AlertTriangle size={16} />
            <div>
              <b>Live model forecasts are not enabled</b>
              <p>
                Live inputs are unvalidated. These Open-Meteo values are
                separate from the trained model.
              </p>
              <button onClick={openDemo}>
                Run historical demo <ChevronRight size={14} />
              </button>
              <button onClick={openHistory}>
                Explore historical data <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </section>
      </div>
      <div className="lower-columns">
        <section className="panel lower-panel">
          <div className="panel-head">
            <div>
              <small>03 / HISTORICAL RECORD</small>
              <h2>Daily maximum temperatures</h2>
            </div>
            <button className="text-button" onClick={openHistory}>
              View trends <ChevronRight size={14} />
            </button>
          </div>
          <div className="history-placeholder">
            <Waves size={19} />
            Select Historical trends to load the source dataset.
          </div>
          <div className="coverage">
            <span>HISTORICAL COVERAGE</span>
            <b>1990–2022</b>
            <i /> CITY-SPECIFIC DAILY RECORDS
          </div>
        </section>
        <section className="panel lower-panel">
          <div className="panel-head">
            <div>
              <small>04 / LOCAL CONDITIONS</small>
              <h2>{city.name}</h2>
            </div>
            <em className="tag">{active?.source ?? "unavailable"}</em>
          </div>
          <div className="current-temp">
            {active?.current?.temperatureC == null
              ? "—"
              : active.current.temperatureC.toFixed(1)}
            <span>°C</span>
          </div>
          <div className="conditions">
            <div>
              <small>APPARENT</small>
              <b>
                {active?.current?.apparentTemperatureC == null
                  ? "—"
                  : `${active.current.apparentTemperatureC.toFixed(1)}°C`}
              </b>
            </div>
            <div>
              <small>WIND</small>
              <b>
                <Wind size={13} />
                {active?.current?.windSpeedKmh == null
                  ? "—"
                  : `${active.current.windSpeedKmh.toFixed(0)} km/h`}
              </b>
            </div>
            <div>
              <small>PRECIP. NEXT DAY</small>
              <b>
                {forecast[0]?.precipitationMm == null
                  ? "—"
                  : `${forecast[0].precipitationMm.toFixed(1)} mm`}
              </b>
            </div>
          </div>
          <div className="fetched">Fetched {timeLabel(active?.fetchedAt)}</div>
        </section>
      </div>
    </div>
  );
}

function HistoryInsights({ summary }: { summary: HistoricalSummary | null }) {
  if (!summary)
    return (
      <div className="content secondary">
        <section className="panel history-insights">
          <div className="empty">
            <Database size={20} />
            Historical summaries are not available.
          </div>
        </section>
      </div>
    );
  return (
    <div className="content secondary history-insights">
      <div className="insight-grid">
        <section className="panel insight-panel">
          <div className="panel-head">
            <div>
              <small>MONTHLY PROFILE · °C</small>
              <h2>Mean daily maximum by month</h2>
            </div>
          </div>
          <div className="insight-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={summary.monthlyProfile}
                margin={{ top: 10, right: 8, bottom: 2, left: 0 }}
              >
                <CartesianGrid stroke="#2b3939" vertical={false} />
                <XAxis
                  dataKey="month"
                  tick={{ fill: "#87958f", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  unit="°C"
                  tick={{ fill: "#87958f", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={45}
                />
                <Tooltip
                  contentStyle={{
                    background: "#182324",
                    border: "1px solid #394748",
                    borderRadius: 3,
                  }}
                />
                <Bar
                  dataKey="meanMaximumC"
                  name="Mean maximum"
                  fill="#e7a954"
                  maxBarSize={24}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="panel insight-panel">
          <div className="panel-head">
            <div>
              <small>YEARLY MEAN · °C</small>
              <h2>Annual mean daily maximum</h2>
            </div>
          </div>
          <div className="insight-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={summary.yearlyMeans}
                margin={{ top: 10, right: 8, bottom: 2, left: 0 }}
              >
                <CartesianGrid stroke="#2b3939" vertical={false} />
                <XAxis
                  dataKey="year"
                  tick={{ fill: "#87958f", fontSize: 10 }}
                  minTickGap={35}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  unit="°C"
                  tick={{ fill: "#87958f", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={45}
                />
                <Tooltip
                  contentStyle={{
                    background: "#182324",
                    border: "1px solid #394748",
                    borderRadius: 3,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="meanMaximumC"
                  name="Mean maximum"
                  stroke="#68b5a4"
                  dot={false}
                  strokeWidth={1.8}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="panel insight-panel">
          <div className="panel-head">
            <div>
              <small>CITY COMPARISON · °C</small>
              <h2>Mean daily maximum by city</h2>
            </div>
          </div>
          <div className="comparison-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={summary.cityComparison}
                layout="vertical"
                margin={{ top: 5, right: 15, bottom: 5, left: 12 }}
              >
                <CartesianGrid stroke="#2b3939" horizontal={false} />
                <XAxis
                  type="number"
                  unit="°C"
                  tick={{ fill: "#87958f", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="city"
                  width={95}
                  tick={{ fill: "#b8c5bd", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    background: "#182324",
                    border: "1px solid #394748",
                    borderRadius: 3,
                  }}
                />
                <Bar
                  dataKey="meanMaximumC"
                  name="Mean maximum"
                  fill="#68b5a4"
                  maxBarSize={18}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="panel insight-panel extremes">
          <div className="panel-head">
            <div>
              <small>OBSERVED EXTREMES</small>
              <h2>Highest recorded days</h2>
            </div>
          </div>
          <div className="extreme-list">
            {summary.extremeDays.map((item) => (
              <div key={`${item.city}-${item.date}`}>
                <span>{item.date}</span>
                <b>{item.city}</b>
                <strong>{Number(item.maximumC).toFixed(1)}°C</strong>
              </div>
            ))}
            {!summary.extremeDays.length && (
              <div className="empty">No observations in this range.</div>
            )}
          </div>
          <small className="units-note">
            Source values only · no precipitation field in dataset
          </small>
        </section>
      </div>
    </div>
  );
}

function HistoryPage({
  cities,
  city,
  setCity,
  from,
  setFrom,
  to,
  setTo,
  rows,
  exportCsv,
}: {
  cities: City[];
  city: string;
  setCity: (s: string) => void;
  from: string;
  setFrom: (s: string) => void;
  to: string;
  setTo: (s: string) => void;
  rows: HistoryRow[];
  exportCsv: () => void;
}) {
  const chart = rows.map((row) => ({ ...row, month: row.date.slice(0, 7) }));
  return (
    <div className="content secondary">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <i /> SOURCE DATA · 1990–2022
          </div>
          <h1>Historical trends</h1>
          <p>
            Daily observations from the supplied cleaned city weather dataset.
          </p>
        </div>
        <button className="button" disabled={!rows.length} onClick={exportCsv}>
          <ArrowDownToLine size={15} />
          Export CSV
        </button>
      </div>
      <div className="filters panel">
        <label>
          City
          <select value={city} onChange={(e) => setCity(e.target.value)}>
            {cities.map((item) => (
              <option key={item.id} value={item.id.replaceAll("-", "_")}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input
            type="date"
            value={from}
            min="1990-01-01"
            max="2022-12-07"
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={to}
            min="1990-01-01"
            max="2022-12-07"
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <span>{rows.length.toLocaleString()} daily records</span>
      </div>
      <section className="panel history-panel">
        <div className="panel-head">
          <div>
            <small>DAILY OBSERVATIONS · °C</small>
            <h2>Maximum temperature observations</h2>
          </div>
          <em className="tag">historical</em>
        </div>
        {rows.length ? (
          <div className="chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chart}
                margin={{ top: 12, right: 14, bottom: 4, left: 0 }}
              >
                <CartesianGrid stroke="#2b3939" vertical={false} />
                <XAxis
                  dataKey="month"
                  tick={{ fill: "#87958f", fontSize: 11 }}
                  minTickGap={48}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  unit="°C"
                  tick={{ fill: "#87958f", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                />
                <Tooltip
                  contentStyle={{
                    background: "#182324",
                    border: "1px solid #394748",
                    borderRadius: 3,
                  }}
                  labelStyle={{ color: "#e8ece8" }}
                />
                <Line
                  type="monotone"
                  dataKey="maximumC"
                  name="Maximum temperature"
                  stroke="#e7a954"
                  dot={false}
                  strokeWidth={1.7}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="empty">
            <Database size={20} />
            No records match this city and date range.
          </div>
        )}
        <div className="chart-foot">
          <span>
            <i className="max-line" />
            Maximum temperature
          </span>
          <span>Minimum temperature is not included in the source.</span>
          <small>cleaned_city_weather.csv · through 2022</small>
        </div>
      </section>
      <section className="panel notes">
        <small>DATA NOTES</small>
        <p>
          This file contains date, city, maximum temperature, and seasonal day
          encodings. It does not include minimum temperature or precipitation
          observations, so the chart leaves minimum values blank rather than
          substituting estimates.
        </p>
      </section>
    </div>
  );
}

function Performance({ metrics }: { metrics: Metrics | null }) {
  const forecast = metrics?.forecasting ?? [];
  const classifiers = metrics?.classifiers ?? [];
  return (
    <div className="content secondary">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <i /> OFFLINE EVALUATION
          </div>
          <h1>Model performance</h1>
          <p>
            Held-out historical test results; not verified live-forecast
            accuracy.
          </p>
        </div>
        <em className="tag">historical test</em>
      </div>
      <div className="performance-cards">
        {[1, 3, 7].map((horizon) => {
          const row = forecast.find(
            (r) =>
              r.Model === "Fine-tuned LSTM" &&
              Number(r.Horizon_days) === horizon,
          );
          const base = forecast.find(
            (r) =>
              r.Model === "Persistence" && Number(r.Horizon_days) === horizon,
          );
          return (
            <section className="panel perf-card" key={horizon}>
              <small>{horizon}-DAY HORIZON</small>
              <b>
                {row ? Number(row.MAE_C).toFixed(2) : "—"}
                <i>°C MAE</i>
              </b>
              <div>
                <span>Persistence baseline</span>
                <strong>
                  {base ? `${Number(base.MAE_C).toFixed(2)}°C` : "—"}
                </strong>
              </div>
              <div>
                <span>R² / RMSE</span>
                <strong>
                  {row
                    ? `${Number(row.R2).toFixed(3)} / ${Number(row.RMSE_C).toFixed(2)}°C`
                    : "—"}
                </strong>
              </div>
            </section>
          );
        })}
      </div>
      <section className="panel table-panel">
        <div className="panel-head">
          <div>
            <small>CLASSIFIER EVALUATION</small>
            <h2>False alarms remain high</h2>
          </div>
          <em className="tag warn">experimental</em>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Horizon</th>
                <th>Precision</th>
                <th>Recall</th>
                <th>F1</th>
                <th>False alarms</th>
                <th>Missed events</th>
                <th>Threshold</th>
              </tr>
            </thead>
            <tbody>
              {classifiers.map((row) => (
                <tr key={String(row.Horizon_days)}>
                  <td>{row.Horizon_days} days</td>
                  <td className="low">
                    {(Number(row.Precision) * 100).toFixed(1)}%
                  </td>
                  <td>{(Number(row.Recall) * 100).toFixed(1)}%</td>
                  <td>{(Number(row.F1) * 100).toFixed(1)}%</td>
                  <td>{Number(row.False_alarms).toLocaleString()}</td>
                  <td>{Number(row.Missed_extreme_days).toLocaleString()}</td>
                  <td>{Number(row.Alert_threshold).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Low precision means many triggered alerts were false alarms. This
          classifier is not an operational public-safety alert system.
        </p>
      </section>
      <section className="panel notes">
        <small>METRIC GUIDE</small>
        <div className="definitions">
          <p>
            <b>MAE</b> is average absolute temperature error in °C; lower is
            better.
          </p>
          <p>
            <b>RMSE</b> penalizes large errors more than MAE.
          </p>
          <p>
            <b>R²</b> describes explained variation and is not a percentage
            accuracy score.
          </p>
        </div>
      </section>
    </div>
  );
}

function Uncertainty({ metrics }: { metrics: Metrics | null }) {
  const rows = metrics?.uncertainty ?? [];
  return (
    <div className="content secondary">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <i /> HISTORICAL RESIDUAL CALIBRATION
          </div>
          <h1>Uncertainty & confidence</h1>
          <p>Nominal 90% intervals from absolute validation residuals.</p>
        </div>
      </div>
      <section className="panel table-panel">
        <div className="panel-head">
          <div>
            <small>TEST-SET INTERVAL BEHAVIOR</small>
            <h2>Coverage and average width</h2>
          </div>
        </div>
        {[1, 3, 7].map((horizon) => {
          const row = rows.find((r) => Number(r.Horizon_days) === horizon);
          const coverage = Number(row?.Test_coverage_percent ?? 0);
          return (
            <div className="uncertainty-row" key={horizon}>
              <span>{horizon}-day</span>
              <div>
                <i style={{ width: `${Math.min(100, coverage)}%` }} />
              </div>
              <b>{coverage.toFixed(1)}%</b>
              <small>
                {Number(row?.Mean_width_C ?? 0).toFixed(2)}°C mean width
              </small>
            </div>
          );
        })}
        <p>
          Historical test coverage is not a guarantee of calibrated intervals
          for current weather inputs.
        </p>
      </section>
      <div className="notice">
        <CircleHelp size={18} />
        <p>
          The live-input preprocessing contract is not present in this
          workspace, so no live LSTM intervals are produced.
        </p>
      </div>
    </div>
  );
}

function Drift({ rows }: { rows: DriftRow[] }) {
  return (
    <div className="content secondary">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <i /> ADWIN · HISTORICAL TEST
          </div>
          <h1>Drift monitoring</h1>
          <p>Saved drift report for the offline evaluation period.</p>
        </div>
        <em className="tag">artifact data</em>
      </div>
      <section className="panel table-panel">
        <div className="panel-head">
          <div>
            <small>CITY × HORIZON</small>
            <h2>Detection summary</h2>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>City</th>
                <th>Horizon</th>
                <th>Samples</th>
                <th>Test MAE</th>
                <th>Detections</th>
                <th>First detection</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.city}-${row.horizonDays}`}>
                  <td>{row.city.replaceAll("_", " ")}</td>
                  <td>{row.horizonDays} days</td>
                  <td>{row.samples.toLocaleString()}</td>
                  <td>{row.maeC.toFixed(3)}°C</td>
                  <td>{row.detections}</td>
                  <td>{row.firstDetection ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && <div className="empty">Drift report unavailable.</div>}
      </section>
    </div>
  );
}

function About() {
  return (
    <div className="content secondary">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <i /> PROJECT NOTES
          </div>
          <h1>About HeatShield-X</h1>
          <p>
            Experimental forecasting research for heat-risk context across
            selected Indian cities.
          </p>
        </div>
      </div>
      <section className="panel notes about">
        <small>MODEL LIMITATIONS</small>
        <h2>Historical skill is not live validation.</h2>
        <p>
          The supplied LSTM and horizon classifiers were evaluated on historical
          weather data. The live-input feature contract needed to build the
          model's 30 × 10 sequence is not included here. Replacing those
          features with recent weather values without validating preprocessing
          could mislead, so live model predictions remain disabled.
        </p>
        <p>
          Offline classifier precision is low and false alarms are numerous.
          HeatShield-X is a research interface, not an operational public-safety
          alert service. Experimental thresholds are not official IMD heatwave
          classifications.
        </p>
        <div className="facts">
          <span>
            Forecast artifact <b>heatshield_x_lstm.keras</b>
          </span>
          <span>
            Classifier artifacts <b>1, 3, and 7 day horizons</b>
          </span>
          <span>
            Historical source <b>1990–2022 · seven cities</b>
          </span>
          <span>
            Live weather source <b>Open-Meteo forecast API</b>
          </span>
        </div>
      </section>
    </div>
  );
}
