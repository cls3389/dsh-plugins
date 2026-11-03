#!/usr/bin/env python3
"""Deterministic, read-only OHLCV technical analysis for the offline user sandbox.

Input is a JSON object emitted by ths_klines or {"rows": [...]}. No network,
credentials, trading, or host data are used. All prices are interpreted in the
adjustment supplied by the market-data tool; this program never adjusts them.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from market_volume import compare_volume

import numpy as np
import pandas as pd


def finite(value):
    if value is None or pd.isna(value) or not math.isfinite(float(value)):
        return None
    return round(float(value), 6)


def percent(current, previous):
    if previous is None or pd.isna(previous) or float(previous) == 0:
        return None
    return (float(current) / float(previous) - 1) * 100


def load_bars(path):
    if path == '-':
        source = json.load(sys.stdin)
    else:
        # Resolve relative files in the calling workspace, not this program's directory.
        source = json.loads(Path(path).read_text())
    if isinstance(source, list):
        rows = source
    else:
        rows = source.get('rows') or source.get('klines', {}).get('rows')
    if not isinstance(rows, list) or not rows:
        raise ValueError('Input must contain non-empty ths_klines rows')
    required = {'date', 'open', 'high', 'low', 'close', 'volume', 'amount'}
    missing = required.difference(rows[0])
    if missing:
        raise ValueError(f'Missing OHLCV fields: {sorted(missing)}')
    bars = pd.DataFrame(rows)
    bars['date'] = pd.to_datetime(bars['date'], errors='raise')
    for column in required - {'date'}:
        bars[column] = pd.to_numeric(bars[column], errors='raise')
    if bars['date'].duplicated().any():
        raise ValueError('Duplicate bar timestamps')
    bars = bars.sort_values('date').reset_index(drop=True)
    numeric = bars[['open', 'high', 'low', 'close', 'volume', 'amount']]
    if not np.isfinite(numeric.to_numpy(dtype=float)).all():
        raise ValueError('Non-finite OHLCV values are invalid')
    if (bars[['open', 'high', 'low', 'close']] <= 0).any().any():
        raise ValueError('Prices must be positive')
    if (bars[['volume', 'amount']] < 0).any().any():
        raise ValueError('Negative volume or amount is invalid')
    if (bars['high'] < bars[['open', 'close', 'low']].max(axis=1)).any() or (bars['low'] > bars[['open', 'close', 'high']].min(axis=1)).any():
        raise ValueError('Inconsistent OHLC range')
    return bars, source if isinstance(source, dict) else {}


def indicators(bars):
    frame = bars.copy()
    frame['date'] = pd.to_datetime(frame['date'], errors='raise')
    for column in ('open', 'high', 'low', 'close', 'volume', 'amount'):
        frame[column] = pd.to_numeric(frame[column], errors='raise')
    close = frame['close']
    for period in (5, 10, 20, 60):
        frame[f'ma{period}'] = close.rolling(period).mean()
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    frame['dif'] = ema12 - ema26
    frame['dea'] = frame['dif'].ewm(span=9, adjust=False).mean()
    frame['macd'] = 2 * (frame['dif'] - frame['dea'])
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    relative = gain / loss.replace(0, np.nan)
    frame['rsi14'] = (100 - 100 / (1 + relative)).where(loss != 0, 100).where(~((loss == 0) & (gain == 0)), 50)
    true_range = pd.concat([
        frame['high'] - frame['low'],
        (frame['high'] - close.shift()).abs(),
        (frame['low'] - close.shift()).abs(),
    ], axis=1).max(axis=1)
    # Wilder ATR (RMA), not a simple moving average of true range.
    frame['atr14'] = true_range.ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    frame['std20'] = close.rolling(20).std()
    frame['boll_up'] = frame['ma20'] + 2 * frame['std20']
    frame['boll_down'] = frame['ma20'] - 2 * frame['std20']
    frame['pct'] = close.pct_change() * 100
    frame['volume_ma5_previous'] = frame['volume'].rolling(5).mean().shift(1)
    frame['volume_ratio5'] = frame['volume'] / frame['volume_ma5_previous']
    return frame


def weekly(frame):
    # Only daily and longer bars are aggregated into calendar weeks. Intraday
    # bars must not be misreported as daily/weekly structure.
    # Label by the last observed bar, never forward-fill non-trading days.
    grouped = frame.set_index('date').groupby(pd.Grouper(freq='W-FRI', label='right', closed='right'))
    result = grouped.agg(open=('open', 'first'), high=('high', 'max'), low=('low', 'min'),
                         close=('close', 'last'), volume=('volume', 'sum'), amount=('amount', 'sum'))
    result = result.dropna(subset=['open', 'close'])
    result['pct'] = result['close'].pct_change() * 100
    result['negative_close_streak'] = (result['close'] < result['open']).astype(int)
    streak = 0
    for negative in reversed(result['negative_close_streak'].tolist()):
        if not negative:
            break
        streak += 1
    return result, streak


def summary(frame):
    latest = frame.iloc[-1]
    low, high = frame['low'].min(), frame['high'].max()
    weeks, negative_streak = weekly(frame)
    fields = ['date', 'open', 'high', 'low', 'close', 'volume', 'amount', 'pct',
              'ma5', 'ma10', 'ma20', 'ma60', 'dif', 'dea', 'macd', 'rsi14',
              'atr14', 'boll_up', 'boll_down', 'volume_ratio5']
    latest_values = {key: latest[key].isoformat() if key == 'date' else finite(latest[key]) for key in fields}
    return {
        'bars': len(frame), 'start': frame.iloc[0]['date'].isoformat(), 'end': latest['date'].isoformat(),
        'latest': latest_values,
        'atr14_percent': finite(latest['atr14'] / latest['close'] * 100) if finite(latest['atr14']) is not None and latest['close'] != 0 else None,
        'ma_distance_percent': {str(n): finite(percent(latest['close'], latest[f'ma{n}'])) for n in (5, 10, 20, 60)},
        'returns_percent': {str(n): finite(percent(latest['close'], frame.iloc[-n - 1]['close']))
                            for n in (5, 10, 20, 60) if len(frame) > n},
        'range': {'high': finite(high), 'high_date': frame.loc[frame['high'].idxmax(), 'date'].isoformat(),
                  'low': finite(low), 'low_date': frame.loc[frame['low'].idxmin(), 'date'].isoformat(),
                  'close_position_percent': finite((latest['close'] - low) / (high - low) * 100) if high != low else None,
                   'close_position_semantics': 'Percent above the interval low: (close-low)/(high-low)*100; not a statistical percentile',
                  'drawdown_from_close_high_percent': finite(percent(latest['close'], frame['close'].max()))},
        'latest_candle': {'body': finite(latest['close'] - latest['open']),
                          'upper_shadow': finite(latest['high'] - max(latest['open'], latest['close'])),
                          'lower_shadow': finite(min(latest['open'], latest['close']) - latest['low']),
                          'gap_percent': finite(percent(latest['open'], frame.iloc[-2]['close'])) if len(frame) > 1 else None},
        'vwap': {str(n): finite(frame.tail(n)['amount'].sum() / frame.tail(n)['volume'].sum())
                 for n in (5, 10, 20) if len(frame) >= n and frame.tail(n)['volume'].sum() > 0},
        'volume': {'latest_amount_yi': finite(latest['amount'] / 1e8),
                   'latest_vs_previous5_mean': finite(latest['volume_ratio5'])},
        'weekly': {'negative_close_streak': negative_streak,
                   'recent': [{'period_end': index.isoformat(), **{key: finite(value) for key, value in row.items()}}
                              for index, row in weeks.tail(8).drop(columns=['negative_close_streak']).iterrows()]},
        'recent_indicators': [{key: row[key].isoformat() if key == 'date' else finite(row[key])
                               for key in ['date', 'close', 'dif', 'dea', 'macd', 'rsi14', 'volume_ratio5']}
                              for _, row in frame.tail(10).iterrows()],
    }


def chart(frame, output, title):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.dates as mdates
    import matplotlib.pyplot as plt
    from matplotlib import font_manager
    from matplotlib.patches import Rectangle
    fonts = [f for f in font_manager.findSystemFonts() if 'NotoSansCJK' in Path(f).name or 'DroidSansFallback' in Path(f).name]
    if fonts:
        # Prefer a font with both Latin/digit and CJK glyphs. Legacy Droid
        # fallback needs DejaVu for Latin; Noto CJK covers both by itself.
        noto = next((f for f in fonts if 'NotoSansCJK' in Path(f).name), None)
        if noto:
            font_manager.fontManager.addfont(noto)
            plt.rcParams['font.family'] = font_manager.FontProperties(fname=noto).get_name()
        else:
            font_manager.fontManager.addfont(fonts[0])
            plt.rcParams['font.family'] = 'sans-serif'
            plt.rcParams['font.sans-serif'] = ['DejaVu Sans', font_manager.FontProperties(fname=fonts[0]).get_name()]
    plt.rcParams['axes.unicode_minus'] = False
    figure, (price_axis, volume_axis, macd_axis) = plt.subplots(
        3, 1, figsize=(14, 9), sharex=True, gridspec_kw={'height_ratios': [3, 1, 1]})
    x = mdates.date2num(frame['date'].dt.to_pydatetime())
    spacing = frame['date'].diff().dt.total_seconds().median()
    spacing = 86400 if pd.isna(spacing) or spacing <= 0 else spacing
    width = max(spacing / 86400 * 0.65, 0.00002)
    for position, row in zip(x, frame.itertuples()):
        color = '#d62728' if row.close >= row.open else '#2ca02c'
        price_axis.vlines(position, row.low, row.high, color=color, linewidth=0.8)
        bottom = min(row.open, row.close)
        price_axis.add_patch(Rectangle((position - width / 2, bottom), width,
                                       max(abs(row.close - row.open), 1e-8), color=color))
        volume_axis.bar(position, row.volume, width=width, color=color)
    for period, color in [(5, '#ff7f0e'), (10, '#1f77b4'), (20, '#9467bd'), (60, '#7f7f7f')]:
        price_axis.plot(x, frame[f'ma{period}'], label=f'MA{period}', linewidth=1)
    price_axis.set_title(title or '前复权K线 · 均线 · 成交量 · MACD')
    price_axis.legend(loc='best')
    price_axis.grid(alpha=0.2)
    volume_axis.set_ylabel('成交量(股)')
    volume_axis.grid(alpha=0.2)
    macd_axis.plot(x, frame['dif'], label='DIF', linewidth=1)
    macd_axis.plot(x, frame['dea'], label='DEA', linewidth=1)
    macd_axis.bar(x, frame['macd'], width=width, color=np.where(frame['macd'] >= 0, '#d62728', '#2ca02c'))
    macd_axis.legend(loc='best')
    macd_axis.grid(alpha=0.2)
    macd_axis.xaxis_date()
    figure.autofmt_xdate()
    figure.tight_layout()
    figure.savefig(output, dpi=140)
    plt.close(figure)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', nargs='?', help='ths_klines JSON file, or - for stdin')
    parser.add_argument('--volume-current', type=float, help='Current cumulative volume/amount, in the same unit as the comparison')
    parser.add_argument('--volume-previous-day', type=float, help='Previous full-session volume/amount')
    parser.add_argument('--volume-previous-same-time', type=float, help='Preferred: historical cumulative volume at the same session time')
    parser.add_argument('--as-of', help='Actual source timestamp, ISO 8601; timezone defaults to Asia/Shanghai')
    parser.add_argument('--chart', help='Optional PNG output in the current user workspace')
    parser.add_argument('--title', default='前复权K线 · 均线 · 成交量 · MACD')
    parser.add_argument('--csv', help='Optional full indicator CSV output in the current user workspace')
    args = parser.parse_args()
    if args.volume_current is not None:
        if args.volume_previous_day is None or not args.as_of:
            parser.error('--volume-current requires --volume-previous-day and --as-of')
        print(json.dumps({'volume_comparison': compare_volume(args.volume_current, args.volume_previous_day, args.as_of, args.volume_previous_same_time)}, ensure_ascii=False, separators=(',', ':')))
        return
    if not args.input:
        parser.error('Provide a bars JSON input or --volume-current')
    bars, source = load_bars(args.input)
    frame = indicators(bars)
    if args.chart:
        chart(frame, args.chart, args.title)
    if args.csv:
        frame.to_csv(args.csv, index=False)
    print(json.dumps({'analysis_version': 1, 'source': source.get('source'),
                      'adjust': source.get('adjust') or source.get('klines', {}).get('adjust'),
                      'chart': args.chart, 'csv': args.csv, **summary(frame)}, ensure_ascii=False, separators=(',', ':')))


if __name__ == '__main__':
    main()
