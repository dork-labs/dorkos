import { describe, expect, it } from 'vitest';
import { evaluateCondition, ignoresNeedsResult, unwrapExpression } from '../expr.ts';

const both = (cond: string | boolean) => [
  evaluateCondition(cond, 'pull_request'),
  evaluateCondition(cond, 'merge_group'),
];

describe('evaluateCondition', () => {
  it('fixes github.event_name to the event, with or without ${{ }}', () => {
    expect(both("${{ github.event_name == 'pull_request' }}")).toEqual(['true', 'false']);
    expect(both("github.event_name != 'pull_request'")).toEqual(['false', 'true']);
    expect(both("github.event_name == 'MERGE_GROUP'")).toEqual(['false', 'true']);
  });

  it('reads status functions on the success path', () => {
    expect(both('${{ always() }}')).toEqual(['true', 'true']);
    expect(both('${{ !cancelled() }}')).toEqual(['true', 'true']);
    expect(both('success()')).toEqual(['true', 'true']);
    expect(both('failure() || cancelled()')).toEqual(['false', 'false']);
  });

  it('short-circuits && and || around unknowns', () => {
    expect(both("github.event_name == 'merge_group' && steps.x.outputs.run == 'true'")).toEqual([
      'false',
      'unknown',
    ]);
    expect(
      both("github.event_name != 'pull_request' || steps.scope.outputs.run == 'true'")
    ).toEqual(['unknown', 'true']);
    expect(both("always() && github.event_name == 'pull_request'")).toEqual(['true', 'false']);
  });

  it('knows the other event’s payload object is absent', () => {
    const labels = "contains(github.event.pull_request.labels.*.name, 'skip-changelog')";
    expect(both(labels)).toEqual(['unknown', 'false']);
    expect(both(`!${labels}`)).toEqual(['unknown', 'true']);
    expect(both('github.event.pull_request.head.repo.fork != true')).toEqual(['unknown', 'true']);
    expect(both("github.event.merge_group.base_sha != ''")).toEqual(['false', 'unknown']);
  });

  it('handles parentheses, negation and fromJSON lists', () => {
    expect(both("!(github.event_name == 'pull_request' || github.event_name == 'push')")).toEqual([
      'false',
      'true',
    ]);
    expect(both(`contains(fromJSON('["pull_request","merge_group"]'), github.event_name)`)).toEqual(
      ['true', 'true']
    );
    expect(both(`contains(fromJSON('["pull_request"]'), github.event_name)`)).toEqual([
      'true',
      'false',
    ]);
  });

  it('treats unknown contexts and functions as unknown, never as a guess', () => {
    expect(both("vars.FLAG == 'true'")).toEqual(['unknown', 'unknown']);
    expect(both("hashFiles('x') != ''")).toEqual(['unknown', 'unknown']);
    expect(both("needs.shard.result != 'success'")).toEqual(['unknown', 'unknown']);
  });

  it('answers unknown for text it cannot parse', () => {
    expect(both("github.event_name == 'pull_request")).toEqual(['unknown', 'unknown']);
  });

  it('accepts YAML booleans', () => {
    expect(both(true)).toEqual(['true', 'true']);
    expect(both(false)).toEqual(['false', 'false']);
  });
});

describe('ignoresNeedsResult', () => {
  it('is true only for always(), failure() and cancelled() (including !cancelled())', () => {
    expect(ignoresNeedsResult('${{ always() }}')).toBe(true);
    expect(ignoresNeedsResult('${{ !cancelled() }}')).toBe(true);
    expect(ignoresNeedsResult('failure()')).toBe(true);
    expect(ignoresNeedsResult('success()')).toBe(false);
    expect(ignoresNeedsResult("github.event_name == 'merge_group'")).toBe(false);
    expect(ignoresNeedsResult(undefined)).toBe(false);
  });
});

describe('unwrapExpression', () => {
  it('strips one whole-string wrapper and leaves mixed text alone', () => {
    expect(unwrapExpression('${{ a && b }}')).toBe('a && b');
    expect(unwrapExpression('${{ a }} and ${{ b }}')).toBe('${{ a }} and ${{ b }}');
  });
});
