// These checks stay outside the agent's staged workspace. The owner-visible
// check.sh remains the workflow check; these cases test behavior it did not show.
const shell = (body) => [
  '#!/bin/sh',
  'set -eu',
  'cd /work',
  "PYTHONDONTWRITEBYTECODE=1 python - <<'PY'",
  ...body,
  'PY',
  '',
].join('\n')

export function holdoutCheck(task) {
  if (task === 'slugify') return shell([
    'from input import slugify',
    'cases = [',
    '    (" A\\r\\n B ", "a-b"),',
    '    ("A\\v\\fB", "a-b"),',
    '    ("A\\u2003B", "a-b"),',
    '    ("one---two", "one---two"),',
    '    ("", ""),',
    ']',
    'for value, expected in cases:',
    '    actual = slugify(value)',
    '    assert actual == expected, (value, actual, expected)',
  ])
  if (task === 'intervals') return shell([
    'from input import merge_intervals',
    'cases = [',
    '    ([(0, 0), (0, 0)], [(0, 0)]),',
    '    ([(-5, 10), (-3, 0), (2, 3)], [(-5, 10)]),',
    '    ([(3, 5), (1, 10), (2, 7)], [(1, 10)]),',
    '    ([(10, 11), (-2, -1), (0, 0)], [(-2, -1), (0, 0), (10, 11)]),',
    '    ([(8, 9), (1, 4), (4, 6), (7, 8)], [(1, 6), (7, 9)]),',
    ']',
    'for intervals, expected in cases:',
    '    original = list(intervals)',
    '    actual = merge_intervals(intervals)',
    '    assert actual == expected, (intervals, actual, expected)',
    '    assert intervals == original, intervals',
  ])
  throw new Error('unknown holdout task')
}
