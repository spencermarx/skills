# How parcels move through Ardoz Depot

**Covers** the path a parcel takes through Ardoz Depot, the one station that saturates
every night, and the three routes considered for relieving it.

**For** the depot's operations lead and the corridor network planner, who choose between
the three routes at the September planning review.

**Date** 17 August 2026

**Published** not published. This record and the page beside it are the worked sample
shipped with the `create-report` skill. A report that has been published records its URL
and its icon here, so a later revision returns to the same link under the same tab icon.

**Invented** Ardoz Depot does not exist. Its layout, its figures and its three routes were
written to demonstrate the form of a report, and none of them should be cited as fact.

## Method

Volumes, dwell times and misroute rates are the rolling 30-day median for weekdays from
17 July to 15 August 2026, read from the depot's scan log. Dwell is the elapsed time
between a parcel's dock scan and its chute scan. A misroute is a parcel that reaches a
chute other than the one its destination maps to, counted at the chute rather than at the
receiving depot.

The three route projections replay the same 30 days of scan records against each route's
rules. They assume arrival times hold: a route that only works because the trunk lines
arrive differently is not projected here.

The all-shift dwell figure in the throughput table is the median across every parcel in
the day, not the mean of the three shift medians. The two differ because the night shift
carries almost half the volume at more than twice the dwell.

## The depot

Ardoz Depot is the regional sorting hub on the northern corridor. It has three unload
docks - trunk, local and returns - one induction arch, one cross-belt sorter, and 24
chutes discharging to the outbound bays.

Between the dock and the truck a parcel is handled five times: it waits in the yard queue,
passes the induction arch, crosses the sorter, drops into a chute, and is loaded at an
outbound bay.

The depot moves 84,200 parcels on an average weekday.

## The induction spine

Every parcel in the building passes one induction arch. There is no second arch and no
bypass, so the arch's rated throughput is the depot's throughput.

- The arch is rated at 9,400 scans an hour.
- Arrivals peak at 11,300 an hour between 23:00 and 01:00, on four nights in five.
- The arch runs at capacity for 214 of the night shift's 480 minutes, and the yard queue
  builds behind it for as long as it does.
- The night shift carries 41,200 parcels, 49% of the day's volume.
- Median night dwell is 148 minutes, more than twice the day shift's 71.

Nothing downstream of the arch has run out of capacity in the 30 days measured. The
cross-belt sorter's busiest hour used 71% of its rating; no chute has been blocked for
more than four consecutive minutes; the last outbound bay door frees at 05:10.

## Throughput by shift

One weekday at Ardoz, by shift. Rolling 30-day median to 15 August 2026.

| Shift     | Window      | Parcels in | Parcels sorted | Carried out | Median dwell | Misroute | Arch at capacity |
| --------- | ----------- | ---------- | -------------- | ----------- | ------------ | -------- | ---------------- |
| Night     | 22:00–06:00 | 41,200     | 40,850         | 350         | 148 min      | 1.9%     | 214 of 480 min   |
| Day       | 06:00–14:00 | 22,600     | 22,740         | 210         | 71 min       | 1.1%     | 41 of 480 min    |
| Twilight  | 14:00–22:00 | 20,400     | 20,610         | 0           | 63 min       | 0.8%     | 0 of 480 min     |
| All three | 24 h        | 84,200     | 84,200         | 0           | 96 min       | 1.4%     | 255 of 1,440 min |

Parcels sorted differs from parcels in within a shift because each shift hands its
unsorted remainder to the next. The night shift hands 350 parcels to the day shift and the
day shift hands 210 to twilight; twilight clears the building.

## Peak hour dwell under each route

Median dwell for a parcel arriving in the 23:00 to 01:00 peak, today and under each route:

| State   | Peak-hour median dwell |
| ------- | ---------------------- |
| Today   | 148 min                |
| Route A | 74 min                 |
| Route B | 96 min                 |
| Route C | 141 min                |

The three figures are not additive. Route A and Route B both relieve the arch, so running
them together would not subtract twice.

## Route A: a second induction arch

Build a second arch against the west wall, fed directly by the trunk dock. The local and
returns docks keep feeding the existing arch.

- Combined rating: 18,800 scans an hour, against a peak demand of 11,300.
- Peak-hour median dwell falls from 148 minutes to 74.
- No minute of the night is spent at arch capacity.
- Lead time: 11 months, including structural work on the west wall.

The cost is downstream. With the arch no longer holding parcels back, the sorter reaches
the chutes earlier and the outbound bays become the binding station: bay doors would need
to be free by 04:20, and today the last one frees at 05:10. The bays carry no scan of
their own, so a constraint that moves there stops being visible in the scan log that
produced every figure in this record.

## Route B: pre-sorted trunk containers

Have the four origin depots load trunk containers by destination chute group. A container
that arrives correctly loaded goes to a chute spur and never passes the arch or the
sorter.

The four origin depots are BIL-04, VIT-02, LOG-01 and PMP-03.

- 15,700 parcels a night arrive in trunk containers, 38% of night volume.
- The arch's night load falls from 41,200 parcels to 25,500.
- Peak-hour arch demand falls from 11,300 an hour to 7,000, below the 9,400 rating.
- Peak-hour median dwell falls from 148 minutes to 96.
- Handlings per trunk parcel fall from 5 to 2.
- No capital work. Each origin depot needs about 6 weeks to change its loading standard.

The risk is a container loaded to the wrong chute group. It is unsortable at the spur, so
it returns to the arch whole and costs more arch time than routing it there in the first
place would have.

## Route C: rebuild the exception loop

A parcel whose label does not read at the arch leaves the line for the exception desk, is
re-labelled, and rejoins at the head of the arch queue - so every exception costs the arch
a second pass. Rebuild the loop so a re-labelled parcel rejoins downstream of the arch, at
the chute spur.

- 2,900 parcels a night leave the line at the arch.
- 1,180 of those need a third pass.
- Together the extra passes consume 26 minutes of arch time a night, a tenth of the arch's
  running time.
- Peak-hour median dwell falls from 148 minutes to 141: seven minutes.
- The change is one release of the sorter control software. Nothing on the floor moves.

## What to take away

The arch is the depot's only constraint, and Route B is the only route that takes work off
it rather than building capacity around it. It removes 15,700 parcels a night from the
arch at no capital cost, and it leaves the constraint where the depot already measures it.

Route A buys the most time and spends it moving the constraint to the outbound bays, which
carry no scan. Route C is real and small: seven minutes for one software release.
