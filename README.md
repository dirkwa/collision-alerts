# Signal K Collision Alerts

Warns you when another boat is on course to cross your path.

The plugin watches every AIS target around you, and radar or camera targets too. For each boat it works out whether it will cross your course ahead of you, how far ahead of your bow, and how soon. If it will cross too close ahead too soon, or is heading straight for you, the plugin raises an alarm. Boats that pass clear on either side, as in a channel, or cross behind you stay quiet; one that will pass within a small passing distance of you still raises. Chart plotters such as Freeboard-SK show and sound it, and you can acknowledge or silence it from any app.

## Getting started

Install **Collision Alerts** from the App Store. It starts by itself with the Coastal limits. If it shows as off, enable it in its settings.

- **Using SK Derived Data for CPA?** Turn its CPA calculation off, or every alarm comes twice.
- **Had the older `signalk-collision-alerts` plugin?** Uninstall it, or every alarm comes twice. Its settings don't carry over.
- **Have radar or a camera?** Also install **Target Fusion** from the App Store. A boat seen on both AIS and radar then raises one alarm, not two.
- **Have S-57 (ENC) charts?** Serve them with **Charts Provider Simple** 2.22 or later from the App Store. A boat that could reach you only across charted land, such as one behind a headland or an island, then raises nothing, within the limits under **Behind land** below. There is nothing to set up.

## Settings

**Where do you sail?** Pick a sailing area; its alarm distances and times show right below, and you can change them:

| Where you sail            | Warning if a boat will cross ahead within | Alarm if it will cross ahead within | Boats passing beside you |
| ------------------------- | ----------------------------------------- | ----------------------------------- | ------------------------ |
| In harbour                | 100 m in the next 5 min                   | 50 m in the next 2 min              | within 15 m              |
| Along the coast (default) | 926 m (0.5 NM) in the next 12 min         | 463 m (0.25 NM) in the next 6 min   | within 50 m              |
| Offshore                  | 1852 m (1 NM) in the next 20 min          | 926 m (0.5 NM) in the next 10 min   | within 100 m             |

A boat that does not cross ahead of you, or any boat while you are stopped, raises only if it will come within the passing distance, at the same times: a boat heading straight for you, or one overtaking up your wake. The harbour distances are also used for slow and stopped boats (see below), whatever you sail.

**When should alarms be quiet?** Alarms are always on unless you choose otherwise:

- **When you are moored at your berth**: _Alarms as usual_, _Only for boats coming straight at you_ (every boat gets the harbour distances) or _No alarms_. Read from your boat's navigation state, set by signalk-autostate.
- **When you are at anchor**: _Alarms as usual_ or _No alarms_. A boat dragging onto you raises nothing either: turn it on only if something else watches your anchorage.
- **When you are inside any of these regions**: regions are areas you draw on the chart in Freeboard (or any app that saves regions). Draw one around each marina you use, entrance included, and tick it here: while you are inside it, you get no notifications, neither from your own movement nor from boats heading towards you.
- **Pause button.** A KIP switch on `navigation.collisionAlerts.paused` (numeric): 1 stops all alarms for the minutes set here, 30 by default; 0 resumes. Alarms come back by themselves.

The plugin status says when and why it is quiet.

**Advanced settings**, for experienced users: the speed below which both boats use the harbour distances, the maximum number of boats raising alarms at the same time, the range, how long a boat is tracked without data from it, and how often the plugin checks.

**Integration with other apps**: whether each boat's closest approach is sent to chart apps such as Freeboard.

Settings saved by version 0.8 or earlier are converted once when the plugin starts: Custom becomes _Along the coast_ with its numbers, its lowest level zone giving the warning and its highest the alarm. A Custom with more than two zones loses the ones in between; the server log lists them.

## What to expect

The plugin tries to alarm only when it matters:

- **In harbour.** While you and another boat are both slower than 3 kn, the Harbour limits apply. A boat crossing more than 100 m ahead of you stays quiet, as does one passing more than 15 m off.
- **At your berth or at anchor.** While you are stopped, boats coming and going raise only if they will come within 15 m. A boat at 6 kn or faster raises, at the times of your chosen limits, while 3° of error in its course could bring it within those 15 m, so a ship far off heading for you still warns in good time, while a ferry passing well clear raises nothing. With **When you are moored at your berth** set to _Only for boats coming straight at you_, every boat gets the Harbour limits while you are stopped and your boat's navigation state is moored, fast ones too: in a marina they slow and turn for their berths a few boat lengths off. One heading for you still warns about 5 minutes and alarms 2 minutes before its closest approach. Choose it only if moored means lying at a berth: signalk-autostate also reports moored at anchor while no anchor position is set, on a buoy, and while drifting slowly.
- **Quiet times.** At your berth or at anchor, quiet only while you are stopped: alarms come back as soon as you move or the state changes. Inside a ticked marina region, or while paused, quiet even under way. Alarms already raised clear at once.
- **Stopped boats.** A boat slower than 0.5 kn gets the Harbour limits, whatever your speed. Passing it more than 15 m off raises nothing. Heading straight for it warns about 5 minutes ahead.
- **Dragging anchor.** A boat that seems stopped but keeps moving in a straight line counts as moving once it has dragged about 60 m. A neighbour dragging towards you then warns, by the Harbour limits, about 5 minutes before it would reach you. The same goes for your own boat.
- **Overtaking.** A boat you slowly overtake raises only if it will cross within 100 m ahead of you or pass within 15 m. One that turns into you still warns in good time.
- **Boats crossing behind you.** While you are under way, a boat that will cross your wake raises nothing, unless it will come within the passing distance.
- **Between AIS reports.** Small boats report only every 30 s. In between, each boat is judged where it is by now, carried on along its course for up to a minute. A boat moving slower than 3 kn, judged by the Harbour limits, alarms only once a report puts it inside the alarm limits, or once its last report is 40 s old: it may be turning into its berth. A faster boat, judged by them at your berth with _Only for boats coming straight at you_, alarms on dead reckoning at once.
- **Busy waters.** At most 3 boats warn or alarm at once, the most urgent first. A warning that had to make room for a more urgent boat stays quiet for 2 minutes, unless it turns into an alarm or clears the limits and comes back.
- **No flicker.** An alarm stays on until the boat is clearly outside the limits again.
- **Behind land.** With S-57 (ENC) charts served by Charts Provider Simple 2.22 or later, a passage ends where a boat, or you, would reach charted land: at least 150 m of it along the course, with charted water right before and after, on the course and on the courses 3° to either side. The boat would have to go round. It raises only if it comes close enough before that, as one that first crosses your bow does, and is judged anew as soon as its course runs clear. A course once stopped by land is stopped at the same place again by 50 m of it, so one swinging across the tip of a headland does not switch the alarm on and off. This is kept through gaps of up to a minute in judging the boat. A course that only clips a point, land where any chart shows water or a chart could not be read, land next to waters no chart covers (such as unsurveyed areas) and land right where a boat or its closest approach is charted never count. Overview charts, which have no tiles at zoom 14, are not read. While the charts for a course load, no warning or alarm rises, for at most 10 s. Charts can be wrong or out of date: where a chart shows land that is really water, a boat coming across it raises no warning or alarm, so this relies on the charts you serve being right for your waters.

The 3 kn is the advanced setting **Use the harbour distances when both boats are slower than X knots**. Set it to 0 to turn off the harbour, berth, stopped-boat and overtaking rules above, so every boat gets your chosen limits. Boats crossing your wake still stay quiet. The 3 boats are **No more than X boats raising alarms at the same time**.

## Radar alarms from mayara

A current mayara plugin leaves radar collision alarms to this plugin, so a boat seen on radar alarms once. With an older one, set its radar collision alarm setting to _Leave to the Collision Alerts plugin_.

## For app developers

Each alarm is a notification at `notifications.navigation.closestApproach.<target id>` on your own vessel, raised through the server's Notifications API, or as a plain notification delta on servers that don't manage notifications. Its `data` holds `targetRef` (the target's context, such as `vessels.urn:mrn:imo:mmsi:244123456` or `targets.radar:…`), `source`, `sources` (when radar or a camera sees the target), `cpa` (m), `tcpa` (s), `range` (m), `targetCog` (rad, `null` when stopped), `targetSog` (m/s) and `cpaPositions`. Each target in range also gets `navigation.closestApproach` `{ distance, timeTo }`, which can be turned off. It is published when the target reports, when your course or speed changes, and otherwise at the first evaluation at least 10 s after the last, so a display that shows `timeTo` as received runs up to that long behind: 10 s at the default 2 s interval. Radar and camera targets are read from `targets.<type>:<id>` contexts. One whose `sameAs` names an AIS vessel joins it, and the alarm goes under the vessel's id. Land is read from the `chartTiles` PropertyValue, which a chart provider plugin such as Charts Provider Simple offers: `getTile(chartId, z, x, y)` for its charts' tiles, in-process, so it needs no token on a secured server. The S-57 charts are those the resources API lists with type `S-57`, and their land is their `LNDARE` layer. While the plugin runs, it emits the `collisionAlerts` PropertyValue `{ evaluatesTargets: true }`, and `{ evaluatesTargets: false }` when it stops, so sensor plugins can leave their alarms to it.
