# QD Toolkit: user guide

This guide gives the details of each function. For a short overview and the installation, see the [README](../README.md).

## Contents

- [The setup at the first start](#the-setup-at-the-first-start)
- [The panel in the header](#the-panel-in-the-header)
- [The menu](#the-menu)
- [Time](#time)
- [Zoom bars](#zoom-bars-net-drift-price-charts-interval-map)
- [Cache (Beta)](#cache-beta)
- [Hold the chart while it loads](#hold-the-chart-while-it-loads)
- [Custom price chart](#custom-price-chart)
- [Trade buttons (paper trading)](#trade-buttons-paper-trading)
- [Linked strike charts](#linked-strike-charts)
- [Standard deviation lines](#standard-deviation-lines)
- [Gap close (overnight)](#gap-close-overnight)
- [Live day](#live-day)
- [Rate limit](#rate-limit)
- [Time sliders](#time-sliders)
- [Report a problem](#report-a-problem)
- [Limits](#limits)
- [Privacy](#privacy)

## The setup at the first start

When you start QD Toolkit for the first time, the setup opens. It shows the features in 8 steps. Each step has a short video and the switches of that feature. A switch in the setup is the same switch as in the menu.

- To go to the next step, click "Next" or push `→`. To go back, click "Back" or push `←`.
- To go to a step directly, click its dot at the bottom.
- To see more about a switch, move the mouse onto "i".
- To close the setup, click "Skip" or push `Esc`. Your settings stay.

To open the setup again: open the menu, click "General", then click "Setup guide".

After an update, "What's new" opens 1 time. It shows the new features of this version. To open it again: "General" › "What's new".

## The panel in the header

The panel shows in the QuantData header, after the QuantData logo. It uses only the free space between the logo and the QuantData menus. When this space is narrow, the panel shows fewer controls:

| Free space | Controls in the header |
| --- | --- |
| More than 680 px | All controls. |
| 560–680 px | No start button and no end button. |
| 400–560 px | Step buttons, play, master slider, time field and menu button. The speed menu and "RTH" are at the top of the menu. |
| 300–400 px | Play, master slider, time field and menu button. Use the keys for single steps. |
| 160–300 px | Play, time field and menu button. |
| 100–160 px | Play and menu button. |
| Less than 100 px | The panel shows at the bottom of the page. |

The panel uses the colors of your QuantData color scheme.

If the panel does not find the QuantData header, it shows at the bottom of the page. To move this panel, drag the dots at the left end.

Keys:

| Key | Action |
| --- | --- |
| `←` `→` or `,` `.` | 1 step (1 minute) |
| `Shift` + `←` `→` | 5 steps |
| `Cmd` + `←` `→` (Windows: `Ctrl`) | Go to the start or the end |
| `-` | Play or pause |

The keys have no effect when you type in a text field. The `←` and `→` keys always move all sliders, also when a slider of the page has the focus.

When you push a step key quickly many times, the panel collects the steps. It moves the sliders 1 time, 0.6 s after the last key.

"RTH" (regular trading hours): with "RTH" on, play from a time outside 09:30–16:00 ET starts at 09:30 ET. Play stops at 16:00 ET. The start and end buttons go to 09:30 and 16:00 ET.

If the charts load slowly, use the "Auto" speed. A fixed speed that is too short moves the sliders before the charts show the data.

## The menu

To open the menu, click the menu button (the slider icon with the number) in the panel. The menu opens in the middle of the window. To close it, click outside the menu or push `Esc`.

The menu has 5 categories:

| Category | Content |
| --- | --- |
| Replay | Play budget, Display, Cache, Time sliders, Zoom bars that follow the time |
| Price chart | The custom price chart, its candles, the grid and the price lines |
| Linking | Shared crosshair, Draggable value scale, the strike charts and their links |
| Indicators | Standard deviation lines, Gap close |
| General | Local time, 24-hour clock, Menu size, Help (report, setup guide, What's new, this guide, version), Discord and Ko-fi |

To make the menu larger or smaller: "General" › "Menu size" › S, M or L. The setup uses the same size.

Most rows show more information when you move the mouse onto them.

## Time

By default, the panel shows all times in ET (New York time). QuantData shows your local time. For example, 09:30 ET is 15:30 in Central Europe for most of the year.

To see the times in your time zone, set "General" › "Local time". The time field and the times in the menu then show the time of your computer, without "ET". You type a time in your time zone too. To type a New York time, type "ET" after it, for example `10:30 ET`. The steps and the sync do not change.

"24-hour clock" shows the times of the custom price chart and of the crosshair labels as 20:18, not 8:18 PM.

To go to a time, type it in the time field (for example `10:45`) and push `Enter`. You can also drag the master slider.

A QuantData slider gives its time as a number of minutes. The start point of this number is different for each ticker:

| Ticker | Slider range | Value 0 |
| --- | --- | --- |
| SPX | 0–1440 | 00:00 ET |
| SPY, QQQ, stocks | 0–405 (or 0–390) | 09:30 ET |

The panel finds the ticker type from the range. Thus an SPX chart and an SPY chart go to the same time together. A time outside the range of a slider moves this slider to its start or to its end. For example, 05:00 ET moves an SPY slider to 09:30 ET.

The time of a strike chart is the start of its minute. The chart shows the data at the end of that minute. For example, a strike chart at 10:30 shows the price of 10:31:00. In QuantData's price chart, the candle with this price has the label 10:31. Thus the strike charts seem to be 1 minute behind the price chart. This is how QuantData labels its charts. The custom price chart moves 1 candle to match the strike charts. The menu then shows "Matched to the strike charts: +1 min".

## Zoom bars (Net Drift, price charts, Interval Map)

A chart with a time axis (for example Net Drift) has a zoom bar below the chart, not a time slider. The panel moves this zoom bar with the synced time:

- The right end goes to the synced minute. After each step, the chart shows 1 more minute. The chart never shows the future.
- The left end goes to 09:30 ET. It goes there only when you turn the zoom bar on, after you load the page, and when you use the start or end button with "RTH" on. At all other times, the left end stays where it is.
- If you move the left end by hand, it stays there.
- If the synced time is before the left end (for example a replay before 09:30 ET), the zoom bar shows the chart from its start. At 09:30 ET, the left end goes back to 09:30 ET.
- If you zoom a chart by hand, the panel keeps your zoom until the next step.

The mini chart in the zoom bar shows the full day. "Replay" › "Display" › "Hide the future" covers it after the right end.

A chart with its own time slider (for example Gamma Exposure by Strike) has a strike axis. The panel never moves its zoom bar.

The Interval Map has 2 zoom bars. The zoom bar below the chart (time) follows the time, as the zoom bar of Net Drift does. The zoom bar at the right of the chart (strikes) is linked with the strike charts (see "Linked strike charts").

The Exposure Forecast shows a forecast after its time. The panel moves its time slider, but not its zoom bars.

To turn a zoom bar on or off, set or clear its switch in "Replay" › "Zoom bars that follow the time". All zoom bars of charts without a time slider are on by default. The panel keeps your selection after a reload.

## Cache (Beta)

The cache keeps the minutes that you loaded before. A step to such a minute shows at once and costs no data request. The cache is off by default. We recommend that you turn it on.

To turn it on: "Replay" › "Cache" › "Enable cache".

- "Cache size (minutes)": the number of minutes per chart in memory: 200, 400, 800 or "Day". When the cache is full, the oldest minutes go first. A whole day needs more memory.
- The line at the top of the section shows the minutes in the cache and the memory, for example "380 min · 46 MB".
- The bar below shows the minutes of this day in the cache. Bright: all charts. Dim: some charts.
- "Outside RTH": the cache also keeps the minutes before 09:30 and after 16:00 ET.
- "Clear cache" removes all minutes from the cache.

How it works:

- For the strike charts, the cache keeps the data of each minute. A step to a minute in the cache draws this data at once, in your current zoom. This needs "Draggable value scale" (see "Linked strike charts").
- For the other charts, the cache keeps a picture of each minute.
- When you step quickly over minutes in the cache, only the pictures and the data change. QuantData moves its sliders 1 time, 0.9 s after the last step.
- Play over minutes in the cache does not wait for QuantData. QuantData moves its sliders when play stops.
- The newest minutes of a live day do not go into the cache, because their data can still change.
- A reload empties the cache.

The cache is a new feature. If something does not work, tell me on Discord (see "Report a problem").

## Hold the chart while it loads

After a step, QuantData shows "Loading chart data..." until the new data is drawn. With "Replay" › "Display" › "Hold chart while loading" on, each chart shows its old picture during this time. A small turning circle at the top right of the chart shows that new data loads. The picture goes away when QuantData has drawn the new chart. Your clicks and the mouse go through the picture to the page. When you zoom or drag a chart, its picture goes away at once.

Only charts with a time slider get a picture.

The same page can be open in a second window, for example in a Safari web app (File > Add to Dock) on a second screen. When you step in one window, QuantData moves the sliders in the other window too. The panel in the other window then also holds the charts:

- The first step after you open the window shows the loading text of QuantData. From the second step, the panel holds the charts.
- The panel must run in both windows.

## Custom price chart

The custom price chart replaces QuantData's "Stock Price / Time" charts. It looks like QuantData's chart, but it is made for backtests:

- It shows the candles up to the replay minute only. It never shows a future price.
- The candles keep their width. Early in the day, the chart does not stretch a few candles over the full width.
- You can pan and zoom freely, as in TradingView. Drag the chart to pan. Use the mouse wheel to zoom the time.
- Drag a scale (the price axis or the time axis) to zoom it. Double-click a scale to get the automatic scale again.
- QuantData's "Reset zoom" button resets the view. "Reset to default" also sets the candles back to 1 minute.

To turn it on or off: "Price chart" › "Custom price chart". Off: QuantData's own charts.

Candles:

- "Candle" or "Line": candles or a line of the closes.
- The interval: 1, 2, 3, 5, 10, 15 or 30 minutes, or 1 hour.
- The chart builds each interval from the 1-minute candles. The last candle ends at the replay minute. Thus a 5-minute candle never contains a future minute.
- The chips "Candle" and "1 Min" in the toolbar of the chart set the same values. QuantData itself always loads the 1-minute candles.

More options in "Price chart":

- "OHLC values": the open, high, low and close of the candle under the mouse.
- "Price line": a line at the price of the replay minute.
- "Grid": off, horizontal, vertical or both; solid, dashed or dotted; and its opacity.
- "Price lines": click the price axis to add a line at the nearest strike. Click a line on the axis to remove it. A line has a width in points, so it keeps its meaning at each zoom. Set the width and the strike step of new lines. "Keep lines in view" makes the automatic price scale include the lines and the trade lines. "Lines per day" shows a line only on the day where you added it.

## Trade buttons (paper trading)

The trade buttons let you trade in a backtest without real orders. They show at the top left of the custom price chart: SELL, the number of contracts, BUY and the contract.

The contract follows the ticker of the chart:

| Ticker | Contracts |
| --- | --- |
| SPX | ES ($50 per point) or MES ($5 per point) |
| NDX | NQ ($20 per point) or MNQ ($2 per point) |
| RUT | RTY ($50 per point) or M2K ($5 per point) |

To trade:

1. Click BUY or SELL. The position opens at the price of the replay minute.
2. To set a take profit or a stop loss, drag the [TP] or [SL] chip out of the tag of the position line.
3. To move a line, drag its tag.
4. Step or play. The position closes automatically when a candle reaches the take profit or the stop loss.
5. To close the position by hand, click × on its tag.

To place an order at a price, right-click the chart at that price. Below the current price, it is a limit order. Above the current price, it is a stop order (as in TradingView). The order fills at the first candle that reaches its price.

The tag shows the side, the size and the profit or loss in points and in $. A step back shows the trade as it was at that minute.

To turn the buttons on or off: "Price chart" › "Trade buttons".

## Linked strike charts

Strike charts (for example Delta Exposure by Strike or Net GEX by Strike) of the same ticker are linked. The panel reads the ticker from the chart title, for example "SPX" in "Delta Exposure By Strike - SPX". A strike chart without a ticker in its title goes into the group with the same strikes.

- When you zoom or scroll one linked chart (mouse wheel or zoom bar), the other charts of the group show the same strikes. Each chart shows its nearest strikes.
- The other charts move together with your chart while you drag or turn the mouse wheel.
- When QuantData moves a linked chart after new data, the panel moves it back to the strikes that you selected.
- A step in time never moves a strike chart.
- The strike zoom bar of an Interval Map is also linked.

"Linking" › "Strike charts" shows each strike chart with 3 columns:

| Column | Meaning |
| --- | --- |
| Strikes | The chart shows the same strikes as the other charts of its ticker. |
| Scale | Charts with the same letter share their value scale. |
| Crosshair | The chart shows the crosshair line of the other charts. |

### Draggable value scale

"Linking" › "Draggable value scale" keeps the value axis of the strike charts fixed. QuantData then does not scale the chart again at each step. Thus you can compare the bars of 2 minutes.

- Drag the value axis (or use the mouse wheel on it) to change the range.
- Double-click the value axis to get the automatic range of now.
- The cache needs this option for the instant steps of the strike charts.

### Shared crosshair

When the mouse is on a chart, the other charts of the same type show a dashed line at the same position:

- Linked strike charts show the line at the same strike.
- Charts with a time axis (for example Net Drift and price charts) show the line at the same minute.

The line and its label look like the QuantData crosshair. The other charts do not show the QuantData tooltip. To turn the lines off, clear "Linking" › "Shared crosshair".

## Standard deviation lines

The strike charts can show the expected move of one session (the 15.87 rule): 1σ = prior close × prior-close VIX ÷ 15.87 %. Example: SPX prior close 7,500 and VIX 15.0 give 1σ = ±70.88 points.

Each strike chart with a ticker shows a dashed line at the prior close plus and minus each selected σ. A label above the strike axis shows the level, for example "+1σ". The legend of the chart shows each selected level and its price, for example "+1σ 7,884.59". The Interval Map shows the σ lines as horizontal lines.

To turn the lines on: "Indicators" › "Standard deviation (VIX ÷ 15.87)". To show them also on the custom price chart, set "On the price chart".

The panel reads the values automatically. Keep a field empty to use the automatic value. The field then shows this value in grey:

- The prior close of SPX comes from the Net Drift chart of SPX on the page. Before 09:30 ET the index does not trade, thus Net Drift shows the close of the day before.
- The prior-close VIX is not on the QuantData page. The optional script "QD Toolkit Data" loads it from the free daily VIX history of Cboe.
- If there is no Net Drift chart, the panel can also use a "Stock Price / Time" chart of SPX or VIX that you set to the day before. This day must be max. 4 days before the day of the strike charts.

To install "QD Toolkit Data", see "Install" in the [README](../README.md#install). Without it, type the VIX value by hand.

To set the values by hand:

1. Open "Indicators".
2. Type the prior-close VIX, for example 15.87.
3. Type the prior close of each ticker, for example 7,500.
4. Click the levels that you want to see: ±1σ, ±2σ or ±3σ.
5. To see the values of each level, click "i" next to the levels.
6. To remove the lines from a chart, clear its switch in "Charts with σ lines".

A typed value is for the day of the strike charts only. On a different day, the field is empty and the panel uses the automatic value. When you go back to that day, your value is used again. To use the automatic value again, clear the field.

## Gap close (overnight)

The gap is the difference between the open (09:30 ET) and the prior close. "Indicators" › "Gap close (overnight)" shows it on the custom price chart:

- A box between the prior close and the open. "Box opacity" sets its opacity.
- A line at the prior close ("Prior close line").
- A label with the size and the fill, for example "Gap +12.50 · 63% filled". The fill counts only the candles up to the replay minute. "Label": off, the size only, or the size and the fill.

The gap uses the prior close of the section "Standard deviation".

## Live day

On a live day, some QuantData sliders end at the current time. Other sliders show the full session. The panel never moves a slider after the latest data. This applies to the end button, the master slider, the time field, play and steps.

## Rate limit

QuantData stops requests that come too quickly. It then shows the message "You're making requests too quickly". QuantData allows about 60 data requests at one time. Then it allows 1 more request each second. Each slider move makes QuantData load new data: this costs 1 request for each chart with a time slider. QuantData also saves the slider time, but these saves do not count. A minute from the cache costs no request.

"Replay" › "Play budget" shows:

- The free requests (of 60).
- The cost of 1 step back and of 1 step forward, for example "← 4 · → 0 requests". A step into minutes of the cache costs less.
- The 10 requests that stay free for your own clicks.

During play:

1. Before each step, play waits until the step fits into the budget and 10 requests stay free.
2. While play waits, a light ring around the play button gets smaller.
3. With 4 charts, play makes about 1 step each 4 seconds after the first steps.

The panel counts the requests of all QuantData tabs in this browser, also after a reload. It does not see other computers or phones. Your own steps (keys, buttons, time field, master slider) never wait.

If QuantData shows the message:

1. Play pauses for 20 seconds in all tabs. A red ring around the play button gets smaller until play continues.
2. Then play continues at half speed. The play button shows "1/2". Each new message halves the speed again (min. 1/4).
3. To use full speed again, click "1/2 speed" in "Play budget".

Your own steps always run, also during the pause.

## Time sliders

The panel finds the time sliders of the page. "Replay" › "Time sliders" shows each slider with the name of its chart. Move the mouse onto a row: the panel shows a frame around this slider on the page.

A filter slider can look like a time slider. To exclude a slider, clear its switch. The panel keeps your selection for each chart, also when you add or remove other charts and after a reload.

A chart in a tab that you do not see is not in the lists of the menu. The panel does not move its time slider. Thus it causes no requests. When you show its tab again, the panel moves its slider to the time of the other sliders.

If the panel does not find a time slider, send a report (see "Report a problem").

## Report a problem

For questions, problems and ideas, send me a message on Discord. The name is `bsjuli` ("General" › "Copy name"). You can also open an issue on GitHub: https://github.com/julianhtg/qd-toolkit/issues

A report helps to add support for a new chart or to find a fault. It contains the slider data and the structure of 1 element that you click. It contains no prices and no account data.

1. Open the menu and click "General".
2. Click "Copy report…". The menu closes. A message near the menu button tells you what to do.
3. Click the element on the page, for example the zoom bar of a chart. The page does not get this click.
4. Paste the report into your message.

To copy a report without an element, push `Esc` in step 3. If the copy fails, the menu opens again and shows the report as selected text. Push `Cmd` + `C` (Windows: `Ctrl` + `C`) to copy it.

## Limits

- The Infinite Page of QuantData is not supported yet. The panel can find the wrong tools there, and the request budget does not fit this page.
- The custom price chart has no animation. QuantData's own charts have animations.
- The cache keeps the minutes in memory only. A reload empties it.
- The panel moves custom sliders with simulated keys and clicks. A slider that does not accept simulated events does not move.
- The panel finds the time from the slider range only. A slider with a range that is not in the table above shows a number, not a time.
- On a live day, the panel needs the correct clock on your computer.
- "Auto" speed counts the data requests of the page. If QuantData loads data all the time, "Auto" waits up to 15 s per step. In this case, select a fixed speed.
- The panel uses data of the QuantData page. If QuantData changes its page, a function can stop. Then report a problem.

## Privacy

- QD Toolkit runs only in your browser, on the QuantData page.
- It sends no data to the developer or to other servers. It has no tracking.
- It does not call the QuantData API. It uses only the QuantData page in your browser, as you do. The data loads that you see come from QuantData itself, after each slider move.
- The setup loads its videos from the public GitHub repository of QD Toolkit.
- The optional script "QD Toolkit Data" loads 1 public file from Cboe (the daily VIX history) for each page load.
- Your settings stay in the storage of your browser.
