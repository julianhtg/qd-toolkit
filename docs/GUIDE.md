# QD Toolkit: user guide

This guide gives the details of each function. For a short overview and the installation, see the [README](../README.md).

## The panel in the header

The panel shows in the QuantData header, after the QuantData logo. It uses only the free space between the logo and the QuantData menus. When this space is narrow, the panel shows fewer controls:

| Free space | Controls in the header |
| --- | --- |
| More than 680 px | All controls. |
| 560–680 px | No start button and no end button. |
| 400–560 px | Step buttons, play, master slider, time field and slider icon. The speed menu and "RTH" are at the top of the slider list. |
| 300–400 px | Play, master slider, time field and slider icon. Use the keys for single steps. |
| 160–300 px | Play, time field and slider icon. |
| 100–160 px | Play and slider icon. |
| Less than 100 px | The panel shows at the bottom of the page. |

For example, a window with a width of 1600 px gives about 480 px of free space. A MacBook screen of 1512 px gives about 440 px.

The panel in the header uses the colors of your QuantData color scheme.

The panel in the header does not move. If the panel does not find the QuantData header, it also shows at the bottom of the page. To move this panel, drag the dots at the left end.

If the charts load slowly, use the "Auto" speed. A fixed speed that is too short moves the sliders before the charts show the data.

The keys have no effect when you type in a text field. The `←` and `→` keys always move all sliders, also when a slider of the page has the focus.

## Time

By default, the panel shows all times in ET (New York time). QuantData shows your local time. For example, 09:30 ET is 15:30 in Central Europe for most of the year.

To see the times in your time zone:

1. Click the list button.
2. In "Options", set "Show the time in your time zone".

The time field and the times in the list then show the time of your computer, without "ET". You type a time in your time zone too. To type a New York time, type "ET" after it, for example `10:30 ET`. The steps and the sync do not change.

A QuantData slider gives its time as a number of minutes. The start point of this number is different for each ticker:

| Ticker | Slider range | Value 0 |
| --- | --- | --- |
| SPX | 0–1440 | 00:00 ET |
| SPY, QQQ, stocks | 0–405 (or 0–390) | 09:30 ET |

On a live day, the slider ends at the current time. The panel compares the end of the slider with the clock in ET. Thus the panel also finds the ticker type on a live day.

The panel finds the ticker type from the range. Thus an SPX chart and an SPY chart go to the same time together. A time outside the range of a slider moves this slider to its start or to its end. For example, 05:00 ET moves an SPY slider to 09:30 ET.

With "RTH" on, play from a time outside 09:30–16:00 ET starts at 09:30 ET. Play stops at 16:00 ET.

## Zoom bars (Net Drift, price charts, Interval Map)

A chart with a time axis (for example Net Drift or a price chart) has a zoom bar below the chart, not a time slider. The panel moves this zoom bar with the synced time:

- The right end goes to the synced minute. After each step, the chart shows 1 more minute. The chart never shows the future.
- The left end goes to 09:30 ET. It goes there only when you turn the zoom bar on, after you load the page, and when you use the start or end button with "RTH" on. At all other times, the left end stays where it is.
- If you move the left end by hand, it stays there.
- If the synced time is before the left end (for example a replay before 09:30 ET), the zoom bar shows the chart from its start (00:00 ET for SPX Net Drift). At 09:30 ET, the left end goes back to 09:30 ET.

The panel reads the minutes of each zoom bar from the QuantData page. A minute without data has no place on the zoom bar. Thus the panel sets each end to the exact minute. The slider list shows the range of each zoom bar, for example "09:30–11:00". The list shows only the zoom bars that can follow the time. If the panel cannot read the minutes of a chart, the chart is not in the list, and the panel does not move its zoom bar.

The mini chart in the zoom bar shows the full day. The panel covers it after the right end. To show it, clear "Cover the preview after the right end" in the slider list.

The panel moves each zoom bar 1 time for each time change. If QuantData moves the right end after the synced time (for example after a reset), the panel moves the right end back 1 time. If you zoom a chart by hand, the panel keeps your zoom until the next step.

A chart with its own time slider (for example Gamma Exposure by Strike) has a strike axis. The panel never moves its zoom bar.

The Interval Map has 2 zoom bars. The zoom bar below the chart (time) follows the time, as the zoom bar of Net Drift does. The zoom bar at the right of the chart (strikes) is linked with the strike charts (see "Linked strike charts").

The Exposure Forecast shows a forecast after its time. The panel moves its time slider, but not its zoom bars.

To turn a zoom bar on or off:

1. Click the slider icon with the number.
2. Find the list "Zoom bars that follow the time".
3. Set or clear the check box of the chart.

All zoom bars of charts without a time slider are on by default. The panel keeps your selection after a reload.

## Linked strike charts

Strike charts (for example Delta Exposure by Strike or Net GEX by Strike) of the same ticker are linked. The panel reads the ticker from the chart title, for example "SPX" in "Delta Exposure By Strike - SPX". A strike chart without a ticker in its title goes into the group with the same strikes.

- When you zoom or scroll one linked chart (mouse wheel or zoom bar), the other charts of the group show the same strikes. The charts have different numbers of strikes. Thus each chart shows its nearest strikes.
- The other charts move together with your chart while you drag or turn the mouse wheel. Some charts can move only at the end. These charts move when you release the mouse button.
- When QuantData moves a linked chart after new data (for example to the right), the panel moves it back to the strikes that you selected.
- A step in time never moves a strike chart.
- The strike zoom bar of an Interval Map (at the right of the chart) is also linked. It shows the same strikes as the other charts of its ticker. When you zoom it, the other charts follow.

To remove a chart from its group:

1. Click the list button.
2. Find the list "Linked strike charts".
3. Clear the check box of the chart.

The panel keeps your selection after a reload. When you set the check box again, the chart shows the strikes of the group.

## Crosshair line in the other charts

When the mouse is on a chart, the other charts of the same type show a dashed line at the same position:

- Linked strike charts show the line at the same strike. Each chart shows the line at its nearest strike.
- Charts with a time axis (for example Net Drift and price charts) show the line at the same minute.

The line and its label look like the QuantData crosshair. The line goes to the strike or the minute nearest to the mouse, as the QuantData crosshair does. The label below each line shows the strike (for example "$7,520") or the time in your time zone (for example "5:25 PM"), as the time axis of the chart. The other charts do not show the QuantData tooltip. To turn the lines off, clear "Crosshair line in the other charts" in the slider list.

## Standard deviation lines

The strike charts can show the expected move of one session (the 15.87 rule): 1σ = prior close × prior-close VIX ÷ 15.87 %. Example: SPX prior close 7,500 and VIX 15.0 give 1σ = ±70.88 points.

Each strike chart with a ticker shows a dashed line at the prior close plus and minus each selected σ. A label above the strike axis shows the level, for example "+1σ". The legend of the chart shows each selected level and its price, for example "+1σ 7,884.59". If the legend has no room, these items go into a second row. The panel never cuts an item: if the second row has no room, it uses more lines. The QuantData crosshair and its tooltip stay above the lines.

The panel reads the values automatically. Keep a field empty to use the automatic value. The field then shows this value in grey:

- The prior close of SPX comes from the Net Drift chart of SPX on the page. Before 09:30 ET the index does not trade, thus Net Drift shows the close of the day before. The panel sends no request for this.
- The prior-close VIX is not on the QuantData page. The optional script "QD Toolkit Data" loads it from the free daily VIX history of Cboe (1 request to Cboe for each page load, no request to QuantData).
- If there is no Net Drift chart, the panel can also use a "Stock Price / Time" chart of SPX or VIX that you set to the day before. The day of this chart must be max. 4 days before the day of the strike charts. Thus a chart that you forgot on an old day does not count.

To install "QD Toolkit Data", see "Install" in the [README](../README.md#install). Without it, type the VIX value by hand.

To set the values by hand:

1. Click the list button.
2. Find "Standard deviation (VIX ÷ 15.87)".
3. Type the prior-close VIX, for example 15.87.
4. Type the prior close of each ticker, for example 7,500.
5. Click the levels that you want to see: ±1σ, ±2σ or ±3σ. ±1σ and ±2σ are on by default.
6. To see the values of each level, click "i" next to the levels. To hide them, click "i" again.
7. To remove the lines from a chart, clear its check box in "Charts with σ lines". The panel keeps your selection after a reload.

The Interval Map shows the strikes on its vertical axis. Thus it shows the σ lines as horizontal lines, with the label at the left end.

A typed value has priority over the value from the page. A typed value is for the day of the strike charts only (their date). On a different day, the field is empty and the panel uses the value from the page. When you go back to that day, your value is used again. To use the value from the page again, clear the field. The lines follow the zoom of each chart. To turn the lines off, clear the switch next to "Standard deviation".

## Keep the old chart while new data loads

After a step, QuantData shows "Loading chart data..." until the new data is drawn. The panel shows a copy of the old chart (header, chart and zoom bar) during this time. A small turning circle at the top right of the chart shows that new data loads. The copy goes away when QuantData has drawn the new chart. Your clicks and the mouse go through the copy to the page.

Only charts with a time slider get a copy. To see the loading text again, clear "Keep the old chart while new data loads" in the slider list.

The same page can be open in a second window, for example in a Safari web app (File > Add to Dock) on a second screen. When you step in one window, QuantData moves the sliders in the other window too. The panel in the other window then also shows copies of the old charts:

- The first step after you open the window shows the loading text of QuantData. From the second step, the panel shows the copies.
- The panel keeps a picture of each chart for this. It stops 10 minutes after the last step from the other window.
- The panel must run in both windows.

## Live day

On a live day, some QuantData sliders end at the current time. Other sliders show the full session. The panel never moves a slider after the latest data. This applies to the end button, the master slider, the time field, play and steps.

## Rate limit

QuantData stops requests that come too quickly. It then shows the message "You're making requests too quickly". QuantData allows about 120 requests at one time. Then it allows 2 more requests each second. Each slider move makes QuantData load new data: this costs 2 requests for each chart with a time slider. One step moves all synced sliders. For example, one step with 4 charts costs 8 requests.

During play, the panel counts the requests:

1. Before each step, play waits until the step fits into the budget and 20 requests stay free for your own clicks.
2. While play waits, a light ring around the play button in the header gets smaller. The floating panel shows "Budget" and the remaining time.
3. With 4 charts, play makes 1 step each 4 seconds after the first steps. With 10 charts, 1 step each 10 seconds.

The slider list always shows the budget: the free requests (of 120), the cost of 1 step and the 20 requests that stay free for your clicks.

The panel counts the requests of all QuantData tabs in this browser. It also counts the requests after a reload. It does not see other computers or phones. Your own steps (keys, buttons, time field, master slider) never wait. They use the budget too, and play waits longer after them.

If QuantData shows the message:

1. Play pauses for 20 seconds in all tabs. In the header, a red ring around the play button gets smaller until play continues. The slider list shows "Rate limit" and the remaining time. The floating panel shows them next to the buttons.
2. Then play continues at half speed. The play button shows "1/2". Each new message halves the speed again (min. 1/4).
3. To use full speed again, click "1/2 speed" in the slider list (or on the floating panel).

Your own steps always run, also during the pause.

## Select the sliders

The panel finds sliders with `role="slider"` and `input[type="range"]`. A filter slider can also have this form.

1. Click the slider icon with the number.
2. Move the pointer onto a row. Each row shows the name of the chart tab. The panel shows a frame around this slider on the page.
3. Clear the check box of each slider that is not a time slider.

The panel keeps your selection for each chart, also when you add or remove other charts and after a reload.

If the panel does not find a time slider, send a report (see "Report a problem"). Click the time slider in step 3.

A chart in a tab that you do not see (another tab of the same place) is not in the lists of the panel: time sliders, zoom bars, linked strike charts and charts with σ lines. The panel does not move its time slider. Thus it causes no requests. When you show its tab again, the panel moves its slider to the time of the other sliders.

## Report a problem

A report helps to add support for a new chart or to find a fault. It contains the slider data and the structure of 1 element that you click. It contains no prices and no account data.

1. Click the slider icon with the number.
2. Click "Copy report…". The list closes. A message near the slider icon tells you what to do.
3. Click the element on the page, for example the zoom bar of a chart. The page does not get this click.
4. Open a new issue on GitHub (https://github.com/julianhtg/qd-toolkit/issues) and paste the report.

To copy a report without an element, push `Esc` in step 3. If the copy fails, the list opens again and shows the report as selected text. Push `Cmd` + `C` to copy it.

## Limits

- The Infinite Page of QuantData is not supported yet. The panel can find the wrong tools there, and the request budget does not fit this page. Support comes in a later version.
- The panel moves custom sliders with simulated keys and clicks. A slider that does not accept simulated events does not move.
- The master slider, the time field and "Align" need a slider that shows its value (`aria-valuenow` or a range input). A slider without a value accepts steps only.
- A jump on a custom slider uses 3 methods. First, the panel clicks the track 1 time. Then it pushes `Page Up` / `Page Down`. Arrow keys move the last minutes. The panel tests each method one time per slider. If a method has no effect, the panel does not use it again until you reload the page. With arrow keys only, a jump of 300 minutes needs 300 steps.
- The panel finds the time from the slider range only. A slider with a range that is not in the table above shows a number, not a time.
- On a live day, the panel needs the correct clock on your computer. If the end of the slider is more than 20 minutes behind the clock, the panel shows a number, not a time.
- "Auto" speed counts the data requests of the page. If QuantData loads data all the time, "Auto" waits up to 15 s per step. In this case, select a fixed speed.
- The zoom bars and the copy of the old chart use data of the QuantData page. If QuantData changes its page, a chart can go away from the list "Zoom bars that follow the time". Then report a problem (see "Report a problem").
- The panel finds the QuantData header by its class names. If QuantData changes its header, the panel shows at the bottom of the page. Then report a problem (see "Report a problem").

## Privacy

- QD Toolkit runs only in your browser, on the QuantData page.
- It sends no data to the developer or to other servers. It has no tracking.
- It does not call the QuantData API. It uses only the QuantData page in your browser, as you do. The data loads that you see come from QuantData itself, after each slider move.
- The optional script "QD Toolkit Data" loads 1 public file from Cboe (the daily VIX history) for each page load.
- Your settings stay in the storage of your browser.
