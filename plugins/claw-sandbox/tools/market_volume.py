"""Offline A-share session clock and explicit partial-day volume comparisons."""
from datetime import datetime, time
from math import isfinite
from zoneinfo import ZoneInfo

SHANGHAI = ZoneInfo('Asia/Shanghai')


def elapsed_minutes(as_of):
    at = datetime.fromisoformat(as_of) if isinstance(as_of, str) else as_of
    at = at.replace(tzinfo=SHANGHAI) if at.tzinfo is None else at.astimezone(SHANGHAI)
    if at.weekday() >= 5:
        raise ValueError('Weekend is not an A-share trading session')
    # A weekday may still be an exchange holiday. The caller must establish that
    # this is a trading date; this offline helper does not invent a calendar.
    result = 0.0
    for start, end in [(time(9, 30), time(11, 30)), (time(13), time(15))]:
        opening, closing = (datetime.combine(at.date(), t, SHANGHAI) for t in (start, end))
        result += max(0.0, min((at - opening).total_seconds(), (closing - opening).total_seconds())) / 60
    return result


def compare_volume(current, previous_full_day, as_of, previous_same_time=None):
    values = [current, previous_full_day] + ([] if previous_same_time is None else [previous_same_time])
    if any(not isfinite(float(v)) or float(v) < 0 for v in values):
        raise ValueError('Volumes must be finite and non-negative in the same unit')
    minutes = elapsed_minutes(as_of)
    fraction = minutes / 240
    result = {
        'as_of': str(as_of), 'elapsed_trading_minutes': minutes, 'session_minutes': 240,
        'elapsed_fraction': fraction, 'current_cumulative': current,
        'previous_full_day': previous_full_day,
        'raw_ratio_to_previous_full_day': current / previous_full_day if previous_full_day else None,
        'linear_projected_full_day': current / fraction if fraction else None,
        'linear_projected_ratio': current / fraction / previous_full_day if fraction and previous_full_day else None,
        'preferred_method': 'same_time_cumulative' if previous_same_time is not None else 'linear_estimate_only',
        'note': 'Verify an actual trading date, source timestamp and identical units. Linear projection assumes uniform turnover and is not an observed full-day total; prefer historical cumulative volume at the same time. Volume alone does not establish capitulation, a bottom or a rebound.',
    }
    if previous_same_time is not None:
        result['previous_same_time_cumulative'] = previous_same_time
        result['same_time_ratio'] = current / previous_same_time if previous_same_time else None
    return result
