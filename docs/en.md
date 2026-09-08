# ecojoko for Gladys Assistant

Bring the readings of your **ecojoko** energy assistant into Gladys: the live
power draw, today's consumption and, when your display reports them, the
temperature and humidity. The integration also builds a **cumulative index**
from the daily totals, so Gladys can drive its energy dashboard (half-hour
consumption and cost from your contract).

| Sensor                     | Unit  | Meaning                                                             |
| -------------------------- | ----- | ------------------------------------------------------------------- |
| **Live power**             | W     | What the home draws from the grid right now                         |
| **Consumption index**      | kWh   | Cumulative counter since install (the base of the energy dashboard) |
| **Today's consumption**    | kWh   | Today's total, reset every night                                    |
| **_Period_ today**         | kWh   | Same per tariff period (off-peak/peak, Tempo colours…), optional    |
| **Solar surplus today**    | kWh   | Energy exported to the grid, if ecojoko measures it at your place   |
| **Temperature / humidity** | °C, % | Indoor (display) and outdoor, as a second device                    |

## Requirements

- An ecojoko sensor installed and linked to the ecojoko cloud.
- The credentials of your ecojoko account (the mobile app's, or
  [service.ecojoko.com](https://service.ecojoko.com/)).

## Setup

1. Enter your ecojoko **email** and **password**, then save.
2. Click **Test the connection**: the message confirms the gateway found, the
   current power and what your account exposes (tariff periods, solar surplus,
   ambient sensor).
3. Open the integration's **Devices** tab and add the `ecojoko` device (and
   `ecojoko (ambiance)` if it shows up).
4. For the energy dashboard, pick the **Consumption index** feature as the main
   meter in Gladys' energy settings and fill in your contract.

Both refresh rates are configurable: live power (30 s by default) and daily
statistics (5 min by default). Every reading is a request to the ecojoko
cloud: going below a few seconds is pointless, the display itself is not faster.

## Good to know

- **No official API.** ecojoko publishes none; the integration uses the
  interface of its own web app, like the community integrations for Home
  Assistant do. It may stop working if ecojoko changes it. Nothing is ever
  written to your account.
- **The index starts at zero on install**, not at your Linky's value: ecojoko
  does not expose the meter index. Only differences matter to Gladys. The state
  lives in the integration's volume: a restart does not reset it, and days
  missed while stopped are backfilled from ecojoko's weekly statistics.
- **Tariff periods** come from the tariff you declared in the ecojoko app. If
  you change it, save the configuration again: the new sensors will show up in
  Devices.
- **One account, one gateway**: when several gateways are attached to the
  account, only the first one is supported.

## Troubleshooting

- _"ecojoko rejected the email or password"_: check them on
  [service.ecojoko.com](https://service.ecojoko.com/). The integration stops on
  purpose until the configuration is fixed, so your account never gets locked.
- _"ecojoko cloud not answering"_: outage on ecojoko's side or Internet down;
  retries resume by themselves, no action needed.
- _No "ambiance" device_: your account reports no temperature/humidity sensor,
  or the option is disabled in the configuration.

Independent community project, not affiliated with the ecojoko company.
