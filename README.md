# Node.js Server (Express)

# Starlink Prometheus Exporter (Node.js)

A lightweight Prometheus exporter that renders the Starlink Dishy web UI headlessly, extracts the JSON exposed in the page, and converts it dynamically into Prometheus metrics.

The exporter keeps a persistent headless Chromium/Chrome process alive for fast scrapes. The dishy status page is loaded and its updates are paused (using js debugger API). Updates are only resumed for a short moment while a /metrics scrape request is being processed. This saves network traffic and CPU time.

## Features

- Headless rendering of the Dishy web UI (JS executed) to extract the visible JSON
- Dynamic JSON → Prometheus metrics conversion
  - Every metric gets the configured prefix
  - The field `id` is attached as a label to every metric (not a metric itself)
  - Strings are emitted as `<name>{value="..."} 1`
  - Numbers are emitted as numeric values
  - Booleans are emitted as 1/0
  - Arrays emit one sample per element (primitive items as `{value="..."} 1`)
  - Nested keys are NOT concatenated. Metric name = first path segment; remaining path (snake_case) goes into label `name` (e.g., `alerts.dish_is_heating` → `starlink_alerts{name="dish_is_heating",id="<id>"} 0`)
  - All metrics are gauges; `# HELP` and `# TYPE` headers are emitted for each
- Request timing added to the exported JSON as `exporter_request_ms` and exposed as a metric
- Fast scrapes after startup thanks to a persistent headless browser
- Health endpoint (`/health`)
- New metrics are automatically added as they are exposed in the Dishy web UI
- This exporter should work with any (current or future) version of Starlink Dishy
  - ...as long as the Dishy web UI exposes the JSON data in the `<div class="Json-Text">` element

## Example Metrics

```
# TYPE starlink_hardware_version gauge
starlink_hardware_version{value="rev4_panda_prod2",id="ut12345678-12f3456c-d1e23456"} 1
# TYPE starlink_software_version gauge
starlink_software_version{value="2025.11.16.mr67914",id="ut12345678-12f3456c-d1e23456"} 1
# TYPE starlink_utc_offset_s gauge
starlink_utc_offset_s{id="ut12345678-12f3456c-d1e23456"} 0
# TYPE starlink_hardware_self_test gauge
starlink_hardware_self_test{value="PASSED",id="ut12345678-12f3456c-d1e23456"} 1
# TYPE starlink_hardware_self_test_codes_list gauge
starlink_hardware_self_test_codes_list{value="none",id="ut12345678-12f3456c-d1e23456"} 1
# TYPE starlink_alerts gauge
starlink_alerts{name="dish_is_heating",id="ut12345678-12f3456c-d1e23456"} 0
starlink_alerts{name="dish_thermal_throttle",id="ut12345678-12f3456c-d1e23456"} 0
starlink_alerts{name="dish_thermal_shutdown",id="ut12345678-12f3456c-d1e23456"} 0
starlink_alerts{name="power_supply_thermal_throttle",id="ut12345678-12f3456c-d1e23456"} 0
starlink_alerts{name="motors_stuck",id="ut12345678-12f3456c-d1e23456"} 0
starlink_alerts{name="mast_not_near_vertical",id="ut12345678-12f3456c-d1e23456"} 0
starlink_alerts{name="slow_ethernet_speeds",id="ut12345678-12f3456c-d1e23456"} 0
starlink_alerts{name="software_install_pending",id="ut12345678-12f3456c-d1e23456"} 0
starlink_alerts{name="moving_too_fast_for_policy",id="ut12345678-12f3456c-d1e23456"} 0
starlink_alerts{name="obstructed",id="ut12345678-12f3456c-d1e23456"} 0
# TYPE starlink_disablement_code gauge
starlink_disablement_code{value="OKAY",id="ut12345678-12f3456c-d1e23456"} 1
# TYPE starlink_alignment_stats gauge
starlink_alignment_stats{name="boresight_azimuth_deg",id="ut12345678-12f3456c-d1e23456"} -15.91
starlink_alignment_stats{name="boresight_elevation_deg",id="ut12345678-12f3456c-d1e23456"} 84.03
starlink_alignment_stats{name="desired_boresight_azimuth_deg",id="ut12345678-12f3456c-d1e23456"} -34.89
starlink_alignment_stats{name="desired_boresight_elevation_deg",id="ut12345678-12f3456c-d1e23456"} 69.96
# TYPE starlink_stowed gauge
starlink_stowed{id="ut12345678-12f3456c-d1e23456"} 0
# TYPE starlink_exporter_request_ms gauge
starlink_exporter_request_ms{id="ut12345678-12f3456c-d1e23456"} 226
```

## Endpoints

- `GET /`  
  Minimal HTML with links to /metrics and /health.
- `GET /metrics`  
  Renders the Dishy page at `DISHY_ADDRESS`, extracts page JSON and exposes it as Prometheus metrics (text-format v0.0.4).
- `GET /health`  
  Simple health/status JSON.

## Environment Variables

| Variable        | Default               | Description                                                                 |
|----------------|-----------------------|-----------------------------------------------------------------------------|
| `PORT`         | `8055`                | HTTP listen port                                                            |
| `DISHY_ADDRESS`| `http://192.168.100.1`| URL of the Dishy web UI                                                     |
| `METRICS_PREFIX` | `starlink_`         | Prefix for all metric names                                                 |
| `CHROME_BIN`   | auto-detect           | Path to Chromium/Chrome binary; if unset, common names are auto-detected   |
| `CDP_HOST`     | `127.0.0.1`           | CDP (remote debugging) host for the headless browser                       |
| `CDP_PORT`     | `9222`                | CDP (remote debugging) port for the headless browser                        |

Notes:
- A Chromium/Chrome browser must be available on the system. If auto-detection fails, set `CHROME_BIN` explicitly (e.g., `/usr/bin/chromium` or `/usr/bin/google-chrome`).
- The exporter launches a persistent headless browser at startup and cleans it up on shutdown.

## Installation

Prerequisites:
- Node.js >= 18
- Chromium or Google Chrome available on the system (set `CHROME_BIN` if auto-detection fails)

Install:

~~~bash
git clone https://github.com/Finomosec/starlink-prometheus-exporter.git
cd starlink-prometheus-exporter
npm install
npm start  # the exporter listens on http://localhost:8055/metrics by default
~~~

## Prometheus Scrape Config

Add the following to your Prometheus configuration (e.g., /etc/prometheus/prometheus.yml):

~~~yaml
scrape_configs:
  - job_name: "starlink"
    scrape_interval: 30s
    static_configs:
      - targets: ["localhost:8055"]
~~~

Reload Prometheus to apply the changes:
~~~bash
sudo systemctl reload prometheus
~~~

## Run as a service (systemd, user unit)

Save the following unit file as:
~~~text
~/.config/systemd/user/starlink-exporter.service
~~~

Adjust `WorkingDirectory` to your project path.  
Set/adjust `Environment` variables as needed (see the table above).

~~~ini
[Unit]
Description=Starlink Prometheus Exporter
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/services/starlink-prometheus-exporter
# All params optional:
# Environment=PORT=8055
# Environment=DISHY_ADDRESS=http://192.168.100.1
# Environment=METRICS_PREFIX=starlink_
# Environment=CHROME_BIN=/usr/bin/chromium
# Environment=CDP_HOST=127.0.0.1
# Environment=CDP_PORT=9222
# Or: EnvironmentFile=%h/.config/starlink-exporter/env
ExecStart=/usr/bin/npm start --silent
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
~~~

## Enable and start the service

~~~bash
# Reload user-level units
systemctl --user daemon-reload

# Enable autostart on login
systemctl --user enable starlink-exporter

# Start the exporter immediately
systemctl --user start starlink-exporter
~~~

## Metrics and naming notes

- All fields from the visible JSON in the Dishy web UI are dynamically converted to Prometheus metrics.
- Prefix: All metrics start with the configured `METRICS_PREFIX` (default: `starlink_`).
- id label: The `id` field is attached to every metric as a label (not emitted as its own metric).
- Types:
    - Numbers → numeric gauge values
    - Booleans → 1/0
    - Strings → `<metric>{value="..."} 1`
    - Arrays → one sample per element (primitive elements as `{value="..."} 1`)
- Nesting: Nested keys are not concatenated. The metric name is the first path segment; the remaining path (snake_case) is emitted as label `name`. Example: `alerts.dish_is_heating` → `starlink_alerts{name="dish_is_heating",id="123"} 0`.
- Additional exporter metric: `exporter_request_ms` (duration per request in milliseconds).
- Endpoints: `/` (landing page), `/metrics` (Prometheus text format), `/health` (simple health check).

## Debugging

The exporter launches a headless Chrome browser with Chrome DevTools Protocol (CDP) enabled. You can connect from localhost using a Chrome browser to inspect the page:

1. Make sure the exporter is running
2. Open Chrome and navigate to:
   ~~~
   http://localhost:9222
   ~~~
   (or the port configured in `CDP_PORT`)
3. Click on the displayed page to open Chrome DevTools

**Note:** CDP access only works from `localhost`. This is a chrome security measure, as CDP provides full access to the browser.
