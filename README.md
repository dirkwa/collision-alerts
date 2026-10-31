# Signal K Collision Alerts

Warns you when another vessel is on course to pass too close. For every AIS target in range (and every radar or camera target, on servers that merge them) the plugin works out the closest point of approach (CPA) and the time until it (TCPA), and raises a Signal K alarm when both fall inside your chosen limits. Chart plotters such as Freeboard-SK show the alarm, sound it, and let you acknowledge or silence it.

## Setup

Install **@signalk/collision-alerts** from the App Store.

If you have the older `signalk-collision-alerts` package installed, uninstall it: it is no longer updated, and running both raises every alarm twice. Settings do not carry over, so set the alert sensitivity again in the new plugin's settings.

A new installation starts on its own with the Coastal sensitivity; an installation you disabled earlier stays off until you enable it in its settings. To change the sensitivity, pick an **Alert sensitivity** there:

| Sensitivity       | Warn                       | Alarm                      |
| ----------------- | -------------------------- | -------------------------- |
| Harbour           | CPA ≤ 100 m within 5 min   | CPA ≤ 50 m within 2 min    |
| Coastal (default) | CPA ≤ 0.5 NM within 12 min | CPA ≤ 0.25 NM within 6 min |
| Offshore          | CPA ≤ 1 NM within 20 min   | CPA ≤ 0.5 NM within 10 min |
| Custom            | your own list of zones     |                            |

If you used the CPA calculation in **SK Derived Data**, turn it off there so you don't get every alarm twice.

## What it publishes

- `notifications.navigation.closestApproach.<target id>` on own vessel, one alarm per target, through the server's Notifications API so acknowledge and silence work from any app. The alarm's `data` carries `targetRef` (the target's Signal K context, e.g. `vessels.urn:mrn:imo:mmsi:244123456`), `source`, `cpa` (m), `tcpa` (s), `range` (m), the target's `targetCog` (rad, `null` when it is stopped) and `targetSog` (m/s), and `cpaPositions`.
- `vessels.<target id>.navigation.closestApproach` `{distance, timeTo}` for each target in range (can be turned off).

While you and another boat are both slower than 3 kn (**Use Harbour limits when both boats are slower than**), that boat is judged by the Harbour limits, so the boats at anchor you motor past on arrival don't alarm. A boat that is stopped is judged by the Harbour limits at any speed of yours: it can only be hit by steering into it, so passing an anchorage half a mile off raises nothing, while heading straight for an anchored boat still does. A faster boat keeps your chosen limits, and so does one found dragging its anchor. Set it to 0 to turn this off.

A boat slower than 0.5 kn counts as stopped: boats at anchor report a speed and course that are mostly noise, so two of them never alarm on each other. Anything actually moving towards you still does.

A boat that will pass behind you, more than about 105° off your bow at its closest point, raises nothing unless it will come inside the alarm distance, because a boat crossing your wake is not on a collision course. One that will come that close warns and alarms as usual.

A boat that reports being stopped but keeps moving the same way in a straight line, more than 60 m over a few minutes, is judged by its measured course and speed, so a neighbour dragging its anchor toward you raises the alarm. Your own boat is treated the same way. Position noise and a boat swinging at anchor, which moves along an arc, don't count.

By default, at most three targets alarm at once (**Alarm for at most this many targets at once**, 1 to 5): the highest level first, then the soonest closest approach. The rest alarm as soon as they become one of the most urgent, so a crowded anchorage doesn't bury you in alarms.

An alarm escalates as soon as a target enters a stricter zone, and is held until the target is clearly outside it again, so a CPA hovering on a limit doesn't make the alarm flicker.

## Radar and other sensors

The plugin also evaluates radar and camera targets that sensor plugins publish as `targets.<type>:<id>` contexts (mayara does this for ARPA targets), so boats without AIS are covered too. When a fusion plugin such as Target Fusion links a target to the AIS vessel it is (`sameAs`), the two are one boat and raise one alarm, not two. Install Target Fusion alongside this plugin if you have radar or a camera (the App Store lists it as recommended); without it a boat seen on both AIS and radar alarms twice. The boat then moves with whichever sensor reported last, so radar keeps tracking it after its AIS falls silent. The alarm points at the AIS vessel when there is one, and otherwise at the target's context (`targets.radar:…`); `data.sources` lists every sensor that sees it.

Sensor plugins may also raise alarms of their own. While this plugin runs it emits the `collisionAlerts` PropertyValue `{ evaluatesTargets: true }` (and `{ evaluatesTargets: false }` when it stops), and the mayara plugin leaves radar alarms to it then (from the release with [mayara-server-signalk-plugin#148](https://github.com/MarineYachtRadar/mayara-server-signalk-plugin/pull/148)), so a ship seen on radar does not alarm twice. With an older mayara plugin, set its radar collision alarm setting to _Leave to the Collision Alerts plugin_ instead.

## Development

```shell
npm install
npm run build:all   # lint + format check, build, tests
```
