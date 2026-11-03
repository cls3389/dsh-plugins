import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import market_analysis as analysis

rows = []
for i in range(80):
    close = 100 + i * 0.4 + math.sin(i / 4) * 3
    open_ = close - 0.5
    volume = 1_000_000 + i * 10000
    rows.append({'date': (pd.Timestamp('2026-01-01') + pd.Timedelta(days=i)).isoformat(),
                 'open': open_, 'high': close + 2, 'low': open_ - 2, 'close': close,
                 'volume': volume, 'amount': volume * close})
frame = analysis.indicators(pd.DataFrame(rows))
last = frame.iloc[-1]
assert math.isclose(last['ma5'], frame['close'].tail(5).mean())
assert math.isclose(last['ma20'], frame['close'].tail(20).mean())
assert math.isclose(last['dif'], frame['close'].ewm(span=12, adjust=False).mean().iloc[-1] - frame['close'].ewm(span=26, adjust=False).mean().iloc[-1])
assert math.isclose(last['macd'], 2 * (last['dif'] - last['dea']))
tr = pd.concat([frame['high'] - frame['low'], (frame['high'] - frame['close'].shift()).abs(), (frame['low'] - frame['close'].shift()).abs()], axis=1).max(axis=1)
assert math.isclose(last['atr14'], tr.ewm(alpha=1 / 14, adjust=False, min_periods=14).mean().iloc[-1])
assert math.isclose(last['volume_ratio5'], last['volume'] / frame['volume'].iloc[-6:-1].mean())
summary = analysis.summary(frame)
assert summary['bars'] == 80
assert summary['returns_percent']['5'] is not None
assert summary['weekly']['recent']
assert 0 <= summary['range']['close_position_percent'] <= 100
at_low = [dict(row, close=98, open=98, high=103, low=98) for row in rows[:20]]
assert analysis.summary(analysis.indicators(pd.DataFrame(at_low)))['range']['close_position_percent'] == 0
at_high = [dict(row, close=103, open=103, high=103, low=98) for row in rows[:20]]
assert analysis.summary(analysis.indicators(pd.DataFrame(at_high)))['range']['close_position_percent'] == 100
assert math.isclose(summary['atr14_percent'], last['atr14'] / last['close'] * 100, abs_tol=5e-7)
assert math.isclose(summary['latest_candle']['upper_shadow'], 2.0, abs_tol=1e-9)
assert math.isclose(summary['latest_candle']['lower_shadow'], 2.0, abs_tol=1e-9)
assert math.isclose(summary['latest_candle']['body'], 0.5, abs_tol=1e-9)
# Directional and flat RSI extremes, no fabricated indicator during warm-up.
for direction, expected in [(1, 100), (-1, 0), (0, 50)]:
    flat = pd.DataFrame([{**row, 'close': 100 + direction * i, 'open': 100 + direction * i,
                          'high': 102 + direction * i, 'low': 98 + direction * i} for i, row in enumerate(rows)])
    result = analysis.indicators(flat)
    assert math.isclose(result['rsi14'].iloc[-1], expected)
short = analysis.summary(analysis.indicators(pd.DataFrame(rows[:3])))
assert short['latest']['ma5'] is None and short['latest']['rsi14'] is None and short['vwap'] == {}
# No division by zero for suspended/zero-volume bars; no weekday filling.
zero = [dict(row, volume=0, amount=0) for row in rows[:20]]
assert analysis.summary(analysis.indicators(pd.DataFrame(zero)))['vwap'] == {}
# Input parser accepts the actual ths_klines envelope and rejects bad data.
with tempfile.TemporaryDirectory() as directory:
    directory = Path(directory)
    source = directory / 'bars.json'
    source.write_text(json.dumps({'klines': {'source': 'ths-data-center', 'adjust': 'forward', 'rows': rows}}))
    parsed, envelope = analysis.load_bars(str(source))
    assert len(parsed) == 80 and envelope['klines']['source'] == 'ths-data-center'
    for bad in [[], [dict(rows[0], date=rows[1]['date']), rows[1]], [dict(rows[0], high=1)], [dict(rows[0], close=-2)], [dict(rows[0], close=float('nan'))], [{key: value for key, value in rows[0].items() if key != 'amount'}]]:
        source.write_text(json.dumps({'rows': bad}))
        try:
            analysis.load_bars(str(source))
        except ValueError:
            pass
        else:
            raise AssertionError(f'Invalid input accepted: {bad[:1]}')
    output = directory / 'chart.png'
    csv = directory / 'indicators.csv'
    source.write_text(json.dumps({'source': 'fqgate-v2', 'adjust': 'forward', 'rows': rows}))
    result = subprocess.run([sys.executable, str(Path(__file__).with_name('market_analysis.py')), str(source), '--chart', str(output), '--csv', str(csv)], capture_output=True, text=True, check=True)
    payload = json.loads(result.stdout)
    assert payload['source'] == 'fqgate-v2' and payload['adjust'] == 'forward'
    assert output.stat().st_size > 10000 and len(pd.read_csv(csv)) == 80
    # Actual intraday input and stdin envelope; ensure finite JSON (no NaN).
    minute = [dict(row, date=f'2026-10-30 14:{55 + i:02d}:00') for i, row in enumerate(rows[:5])]
    result = subprocess.run([sys.executable, str(Path(__file__).with_name('market_analysis.py')), '-'], input=json.dumps({'rows': minute}), capture_output=True, text=True, check=True)
    payload = json.loads(result.stdout)
    assert payload['bars'] == 5 and 'NaN' not in result.stdout
    minute_chart = directory / 'minute.png'
    subprocess.run([sys.executable, str(Path(__file__).with_name('market_analysis.py')), '-', '--chart', str(minute_chart), '--title', '澜起科技 · 5分钟前复权'], input=json.dumps({'rows': minute}), check=True, capture_output=True, text=True)
    assert minute_chart.stat().st_size > 10000
# Session clock excludes the lunch break; projections stay labelled estimates.
from market_volume import elapsed_minutes, compare_volume
for clock, minutes in [('09:00', 0), ('09:30', 0), ('11:30', 120), ('12:30', 120), ('13:00', 120), ('13:50', 170), ('14:00', 180), ('15:00', 240), ('16:00', 240)]:
    assert elapsed_minutes(f'2026-11-03T{clock}:00+08:00') == minutes
comparison = compare_volume(140, 131, '2026-11-03T13:50:00+08:00')
assert math.isclose(comparison['linear_projected_full_day'], 140 * 240 / 170)
assert comparison['preferred_method'] == 'linear_estimate_only'
assert compare_volume(140, 131, '2026-11-03T14:00:00+08:00', 100)['same_time_ratio'] == 1.4
assert compare_volume(0, 0, '2026-11-03T09:30:00+08:00')['linear_projected_ratio'] is None
result = subprocess.run([sys.executable, str(Path(__file__).with_name('market_analysis.py')), '--volume-current', '140', '--volume-previous-day', '131', '--as-of', '2026-11-03T14:00:00+08:00'], capture_output=True, text=True, check=True)
assert json.loads(result.stdout)['volume_comparison']['elapsed_fraction'] == 0.75
print('PASS: deterministic indicators, RSI/ATR, chart, CLI, session clock and partial-day volume comparisons')
