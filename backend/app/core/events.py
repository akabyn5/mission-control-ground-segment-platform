"""

Persistent mission event generation.

This module is the single source of truth for "did this telemetry sample,

compared against the same satellite's previous sample, produce a mission

event worth persisting." `backend/app/routers/telemetry.py` calls

`generate_events()` once per `POST /telemetry`, in the same database

transaction as the telemetry write itself (see that router for why) —

the resulting `Event` rows are stored in the `events` table (see

backend/app/models/event.py) and broadcast to the dashboard over the same

WebSocket message as the telemetry sample itself.

This module deliberately does NOT evaluate alarm thresholds itself — it

takes the current and previous samples' already-evaluated alarm lists (see

backend/app/core/alarms.py) as parameters, and only compares/diffs them.

This is what makes the alarm-consolidation guarantee automatic: if

`evaluate_alarms()` already merged a critically-low battery reading and a

"power subsystem = Critical" status into one alarm, there is only ever one

alarm object here to turn into one event — this module has no way to

accidentally split it back into two.

Three kinds of events, each independent of the others (a single telemetry

sample can produce more than one at once):

- **Battery**: the satellite's battery percentage dropped by at least

  `BATTERY_DROP_EVENT_THRESHOLD` percentage points versus its previous

  sample (see backend/app/core/config.py). NOT "any decrease" — see the

  threshold discussion below. Independent of the alarm-based events: a

  meaningful drop that also crosses an alarm threshold correctly produces

  both a Battery event AND a Warning/Critical event, since those answer

  different questions ("how much did it change" vs. "is it a problem now").

- **Recovery**: a subsystem that was Warning/Critical on the previous

  sample is Nominal on this one. The alarms list alone can't express this

  — it only ever contains what's currently wrong, never what just got

  fixed — so this is evaluated directly from `subsystems`, not from alarms.

- **Warning / Critical**: one event per alarm rule that is present in the

  current sample's alarms but was NOT present in the previous sample's —

  i.e. edge-triggered, exactly like the alarm evaluation itself. An alarm

  that stays active across many consecutive samples produces exactly one

  event on the sample where it first appeared, not one per sample; an

  alarm that clears and later reappears produces a new event, since by

  then it's genuinely absent from one sample's alarm list before

  reappearing in a later one. This INCLUDES a satellite's first-ever

  sample — see "First-sample anomalies" below.

First-sample anomalies:

`generate_events()` is called with `previous=None` for a satellite's very

first telemetry sample. Battery and Recovery events require a previous

value to compare against and are correctly skipped in that case — there is

no meaningful "dropped from X" or "recovered from Y" without one. But a

Warning/Critical *alarm* present on that very first sample is NOT skipped:

the caller (backend/app/routers/telemetry.py) passes `previous_alarms=[]`

when there is no previous sample, so every alarm on the first sample is,

correctly, "not in the previous (empty) rule set" and produces an event.

This is deliberate: this project's definition of "anomaly" is "a condition

with no earlier sample proving it was already observed and recorded" —

there being no earlier sample at all is the strongest case for that, not

an exception to it. A first sample that happens to already be Nominal

produces no event, since Nominal was never an anomaly in the first place.

Battery event threshold — why not "any decrease":

The telemetry simulator (backend/simulator/telemetry_generator.py)

generates `battery` as an independent `random.uniform(95, 100)` draw on

every packet, not a continuous discharge model. That means "any decrease

versus the previous sample" is true for roughly half of *all* packets,

purely from that random draw — persisting an Event row for each one would

flood the event log with simulator sampling noise, not meaningful mission

history. `BATTERY_DROP_EVENT_THRESHOLD` (backend/app/core/config.py,

default 2.0 percentage points) filters that out while still catching

drops large enough to be operationally notable. This is a deliberate

behavior change from an earlier version of this module, which persisted

every decrease.

"""

from backend.app.core.config import settings

from backend.app.core.health_status import HealthStatus, SUBSYSTEM_LABELS, SUBSYSTEMS

from backend.app.models.event import Event

from backend.app.schemas.alarms import Alarm

def generate_events(

    current,

    previous,

    current_alarms: list[Alarm],

    previous_alarms: list[Alarm],

) -> list[Event]:

    """

    Compares `current` against `previous` (both `Telemetry` rows;

    `previous` is `None` for a satellite's first-ever sample) and returns

    the list of new, not-yet-persisted `Event` rows implied by that

    comparison. The caller is responsible for adding them to the session

    and committing — see the module docstring above for why that must

    happen in the SAME transaction as the triggering telemetry write.

    """

    events: list[Event] = []

    # --- Battery drop ------------------------------------------------

    # Requires a previous sample to compare against — there is no

    # meaningful "dropped from X" on a satellite's first-ever sample.

    if previous is not None:

        drop = previous.battery - current.battery

        if drop >= settings.BATTERY_DROP_EVENT_THRESHOLD:

            events.append(

                Event(

                    satellite_id=current.satellite_id,

                    timestamp=current.timestamp,

                    event_type="Battery",

                    severity=None,

                    message=(

                        f"Battery dropped from {previous.battery:.1f}% to "

                        f"{current.battery:.1f}%"

                    ),

                    rule="battery_drop",

                    subsystem="power",

                )

            )

    # --- Subsystem recovery ---------------------------------------------

    # Also requires a previous sample — "recovery" is meaningless without

    # a prior bad state to recover from. A first sample that happens to

    # already be Nominal is not an anomaly and correctly produces no event

    # here (see "First-sample anomalies" in the module docstring). `or {}`

    # defends the same way backend/app/core/alarms.py does against a

    # legacy row having `subsystems=None`.

    if previous is not None:

        previous_subsystems = previous.subsystems or {}

        current_subsystems = current.subsystems or {}

        for subsystem in SUBSYSTEMS:

            previous_state = previous_subsystems.get(subsystem)

            current_state = current_subsystems.get(subsystem)

            if previous_state is None:

                continue  # nothing to compare against for this subsystem yet

            if current_state == HealthStatus.NOMINAL and previous_state != HealthStatus.NOMINAL:

                events.append(

                    Event(

                        satellite_id=current.satellite_id,

                        timestamp=current.timestamp,

                        event_type="Recovery",

                        severity=None,

                        message=f"{SUBSYSTEM_LABELS[subsystem]} restored",

                        rule=f"{subsystem}_recovery",

                        subsystem=subsystem,

                    )

                )

    # --- Newly-triggered alarms -> Warning / Critical events -------------

    # Deliberately NOT gated on `previous is not None` — see "First-sample

    # anomalies" in the module docstring. `previous_alarms` is already `[]`

    # when there is no previous sample (the caller's responsibility — see

    # backend/app/routers/telemetry.py), which makes every alarm on a

    # first sample correctly "newly triggered" without any special-casing

    # needed here.

    previous_rules = {alarm.rule for alarm in previous_alarms}

    for alarm in current_alarms:

        if alarm.rule not in previous_rules:

            events.append(

                Event(

                    satellite_id=current.satellite_id,

                    timestamp=current.timestamp,

                    event_type=alarm.level,

                    severity=alarm.level,

                    message=alarm.message,

                    rule=alarm.rule,

                    subsystem=alarm.subsystem,

                )

            )

    return events