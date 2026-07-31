"""

Alarm evaluation for satellite telemetry.

This module is the single source of truth for "does this telemetry sample

trigger an alarm, and how severe is it." `backend/app/routers/telemetry.py`

calls `evaluate_alarms()` on every `POST /telemetry` and on every

`GET /telemetry/latest`, and every downstream consumer — the WebSocket

broadcast to the dashboard, and the Chrome extension's REST poll of

`/telemetry/latest` — receives the exact same, already-evaluated alarm

list. Neither client re-implements these threshold rules; they only

display what this module already decided (see frontend/js/dashboard.js and

chrome-extension/popup.js).

Rules are independent and additive across different concerns — a single

telemetry sample can trigger more than one alarm at once (e.g. low battery

AND overheating). Within a single concern that has both a numeric

telemetry threshold AND an overlapping subsystem health status (battery/

power, temperature/thermal, signal_strength/communications — see

METRIC_SUBSYSTEM_OVERLAP below), the two are deliberately merged into one

alarm rather than reported twice: a critically low battery reading and a

"power subsystem = Critical" status describe the same physical incident,

and showing the operator two separate notifications for it would be

confusing dashboard noise, not two problems.

"""

from backend.app.core.config import settings

from backend.app.core.health_status import HealthStatus, SUBSYSTEMS

from backend.app.schemas.alarms import Alarm

# Canned message for each subsystem, per non-Nominal severity — an alarm

# is never raised for a Nominal reading, so there's no Nominal entry here.

# SUBSYSTEMS (imported above) is the single source of truth for which

# subsystems exist; this dict must have an entry for each one, which

# evaluate_alarms()/_evaluate_overlapping() below rely on directly rather

# than guarding against a missing key — an obviously-loud KeyError here

# beats a silently-missing alarm message.

SUBSYSTEM_ALARM_MESSAGES = {

    "power": {

        HealthStatus.WARNING: "Power fluctuation detected",

        HealthStatus.CRITICAL: "Battery failure",

    },

    "thermal": {

        HealthStatus.WARNING: "High temperature",

        HealthStatus.CRITICAL: "Critical thermal failure",

    },

    "communications": {

        HealthStatus.WARNING: "Weak downlink signal",

        HealthStatus.CRITICAL: "Signal lost",

    },

    "adcs": {

        HealthStatus.WARNING: "Attitude drift",

        HealthStatus.CRITICAL: "Attitude control failure",

    },

    "payload": {

        HealthStatus.WARNING: "Payload offline",

        HealthStatus.CRITICAL: "Payload failure",

    },

}

# Which numeric telemetry field overlaps which subsystem's health status —

# see the module docstring and _evaluate_overlapping() below. CPU load has

# no corresponding subsystem (none of the five represents "the onboard

# flight computer"), so it's intentionally absent here and stays a

# standalone numeric-only rule in evaluate_alarms().

METRIC_SUBSYSTEM_OVERLAP = ("power", "thermal", "communications")

def _evaluate_overlapping(

    telemetry,

    *,

    subsystem: str,

    numeric_value: float,

    numeric_label: str,

    numeric_unit: str,

    warning_threshold: float,

    critical_threshold: float | None,

    higher_is_worse: bool,

) -> Alarm | None:

    """

    Evaluates ONE alarm for a concern that has both a subsystem health

    status and an overlapping numeric telemetry threshold. Returns a

    single merged Alarm, or None if neither signal currently indicates a

    problem — never two separate alarms for the same underlying incident.

    `higher_is_worse` controls the comparison direction: True for

    temperature (exceeding the threshold is bad), False for battery and

    signal strength (falling below the threshold is bad). `critical_threshold`

    may be None for metrics that only have a Warning-level threshold

    configured (see backend/app/core/config.py) — in that case the numeric

    side of this check can only ever contribute a Warning, never a Critical.

    If only one of the two signals is actually a problem, this still

    returns exactly one Alarm, carrying just that signal's information.

    backend/simulator/telemetry_generator.py currently rolls subsystem

    states and numeric metrics independently (a disclosed simplification —

    see that file's SUBSYSTEM_STATE_WEIGHTS), so a real out-of-range

    numeric reading is never silently dropped just because the subsystem

    label happens to still read Nominal, and vice versa.

    """

    # `or {}`: defends against a legacy telemetry row whose `subsystems`

    # column is None (see backend/app/models/telemetry.py) reaching this

    # function via GET /telemetry/latest — treated the same as "no

    # subsystem data available," not a crash.

    subsystem_state = (telemetry.subsystems or {}).get(subsystem)

    if higher_is_worse:

        if critical_threshold is not None and numeric_value > critical_threshold:

            numeric_level = HealthStatus.CRITICAL

        elif numeric_value > warning_threshold:

            numeric_level = HealthStatus.WARNING

        else:

            numeric_level = None

    else:

        if critical_threshold is not None and numeric_value < critical_threshold:

            numeric_level = HealthStatus.CRITICAL

        elif numeric_value < warning_threshold:

            numeric_level = HealthStatus.WARNING

        else:

            numeric_level = None

    subsystem_bad = subsystem_state == HealthStatus.WARNING or subsystem_state == HealthStatus.CRITICAL

    numeric_bad = numeric_level is not None

    if not subsystem_bad and not numeric_bad:

        return None

    # Overall severity is the worse of the two signals.

    level = HealthStatus.CRITICAL if HealthStatus.CRITICAL in (subsystem_state, numeric_level) else HealthStatus.WARNING

    description = SUBSYSTEM_ALARM_MESSAGES[subsystem][level]

    if numeric_bad:

        message = (

            f"{telemetry.satellite_id}: {description} "

            f"({numeric_label} at {numeric_value:.1f}{numeric_unit})"

        )

    else:

        message = f"{telemetry.satellite_id}: {description}"

    return Alarm(

        rule=f"{subsystem}_{level.lower()}",

        level=level,

        message=message,

        subsystem=subsystem,

    )

def evaluate_alarms(telemetry) -> list[Alarm]:

    """

    Evaluate every alarm rule against one telemetry sample and return the

    (possibly empty) list of alarms it triggers.

    `telemetry` is duck-typed: it accepts the SQLAlchemy `Telemetry` model

    or the `TelemetryCreate` schema (or anything else exposing the same

    attribute names, including a `subsystems` dict), since this is called

    both from `POST /telemetry` (with a freshly-stored `Telemetry` row) and

    from `GET /telemetry/latest` (with a `Telemetry` row read back out of

    the database).

    `telemetry.subsystems` may be `None` — a legacy row stored before that

    database column existed (see backend/app/models/telemetry.py). Every

    subsystem-related check in this module treats that identically to an

    empty dict (no subsystem data available), never a crash.

    """

    alarms: list[Alarm] = []

    # --- Battery / Power (merged — see METRIC_SUBSYSTEM_OVERLAP) ---------

    power_alarm = _evaluate_overlapping(

        telemetry,

        subsystem="power",

        numeric_value=telemetry.battery,

        numeric_label="battery",

        numeric_unit="%",

        warning_threshold=settings.BATTERY_WARNING_THRESHOLD,

        critical_threshold=settings.BATTERY_CRITICAL_THRESHOLD,

        higher_is_worse=False,

    )

    if power_alarm is not None:

        alarms.append(power_alarm)

    # --- Temperature / Thermal (merged) -----------------------------------

    thermal_alarm = _evaluate_overlapping(

        telemetry,

        subsystem="thermal",

        numeric_value=telemetry.temperature,

        numeric_label="temperature",

        numeric_unit="°C",

        warning_threshold=settings.TEMPERATURE_WARNING_THRESHOLD,

        critical_threshold=None,

        higher_is_worse=True,

    )

    if thermal_alarm is not None:

        alarms.append(thermal_alarm)

    # --- Signal strength / Communications (merged) ------------------------

    communications_alarm = _evaluate_overlapping(

        telemetry,

        subsystem="communications",

        numeric_value=telemetry.signal_strength,

        numeric_label="signal strength",

        numeric_unit="%",

        warning_threshold=settings.SIGNAL_WARNING_THRESHOLD,

        critical_threshold=None,

        higher_is_worse=False,

    )

    if communications_alarm is not None:

        alarms.append(communications_alarm)

    # --- CPU load ----------------------------------------------------------

    # No corresponding subsystem — none of the five represents "the

    # onboard flight computer" — so this stays a standalone numeric rule,

    # unlike the three merged concerns above.

    if telemetry.cpu_load > settings.CPU_WARNING_THRESHOLD:

        alarms.append(

            Alarm(

                rule="cpu_warning",

                level=HealthStatus.WARNING,

                message=(

                    f"{telemetry.satellite_id}: CPU load high at "

                    f"{telemetry.cpu_load:.1f}% (above "

                    f"{settings.CPU_WARNING_THRESHOLD:.0f}%)"

                ),

            )

        )

    # --- ADCS / Payload ---------------------------------------------------

    # No numeric counterpart anywhere in this telemetry schema, so these

    # are evaluated purely from subsystem health — no merge logic needed.

    for subsystem in SUBSYSTEMS:

        if subsystem in METRIC_SUBSYSTEM_OVERLAP:

            continue  # already handled above, merged with its numeric metric

        state = (telemetry.subsystems or {}).get(subsystem)

        if state == HealthStatus.WARNING or state == HealthStatus.CRITICAL:

            alarms.append(

                Alarm(

                    rule=f"{subsystem}_{state.lower()}",

                    level=state,

                    message=f"{telemetry.satellite_id}: {SUBSYSTEM_ALARM_MESSAGES[subsystem][state]}",

                    subsystem=subsystem,

                )

            )

    return alarms

def log_alarms(alarms: list[Alarm], logger) -> None:

    """

    Write one structured log line per alarm, at the level matching its

    severity — Critical alarms via `logger.error()`, Warning alarms via

    `logger.warning()`.

    Takes the caller's own module logger (rather than obtaining one here)

    so log lines are still attributed to whichever module actually

    triggered the evaluation — `backend.app.routers.telemetry`, in

    practice — instead of to this module.

    """

    for alarm in alarms:

        if alarm.level == HealthStatus.CRITICAL:

            logger.error(alarm.message)

        else:

            logger.warning(alarm.message)