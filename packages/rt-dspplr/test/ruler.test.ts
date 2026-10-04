// Node tests for the time ruler (run: npm test). The labelled step grows with
// the visible window up to hours, so a long clip's ruler reaches its end with
// a readable number of labels, and labels past an hour carry the hour.

import assert from 'node:assert/strict';
import { computeTicks, formatTick, majorStepFor } from '../src/core/timeline/ruler';

const results: string[] = [];

for (const duration of [600, 3600, 7200, 4 * 3600]) {
    const ticks = computeTicks(duration, 0, 1);
    const majors = ticks.filter((tick) => tick.major);
    const step = majorStepFor(duration);
    assert.ok(majors.length >= 4 && majors.length <= 13, `${duration} s: ${majors.length} labels`);
    const last = majors[majors.length - 1];
    assert.ok(last.left >= 100 - (step / duration) * 100 - 1e-6, `${duration} s: labels reach the end (last at ${last.left.toFixed(1)}%)`);
    assert.equal(new Set(majors.map((tick) => tick.label)).size, majors.length, `${duration} s: labels are distinct`);
    results.push(`${duration} s: step ${step} s, ${majors.length} labels, last "${last.label}" at ${last.left.toFixed(1)}%`);
}

// Zoomed into a long clip, the fine steps apply to the window, not the clip:
// two seconds of a two-hour clip get the quarter-second step, nine labels.
assert.equal(majorStepFor(0.5), 0.05);
assert.equal(majorStepFor(2), 0.25);
assert.equal(computeTicks(7200, 0.5, 2 / 7200).filter((tick) => tick.major).length, 9);

assert.equal(formatTick(3600, 600), '1:00:00');
assert.equal(formatTick(5400, 600), '1:30:00');
assert.equal(formatTick(90, 10), '1:30');
assert.equal(formatTick(1.5, 0.5), '0:01.50');
results.push('labels: m:ss below an hour, h:mm:ss from one hour, hundredths under a one-second step');

console.log(results.map((line) => `  ok  ${line}`).join('\n'));
console.log('\nruler tests passed');
