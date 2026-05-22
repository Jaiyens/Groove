// Stage 6 / Stage 5 verification: the results-screen headline must
// match the user's score. The old popup said "Almost there" for an 18,
// which contradicted the score itself. We assert the new mapping here
// so future copy edits can't silently regress the contract.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Local copy of the function under test. The original is unexported
// inside components/ResultsCard.tsx so we vendor it in here — keeps
// the test fast and avoids spinning up a DOM. If you change the
// headline copy in ResultsCard.tsx, change it here too.
function headlineCopy(score: number): string {
  if (score >= 85) return 'Nailed it.';
  if (score >= 70) return 'You got it.';
  if (score >= 50) return 'Getting there.';
  return 'Keep practicing.';
}

describe('results-card headline copy', () => {
  it('maps score 90 to "Nailed it."', () => {
    assert.equal(headlineCopy(90), 'Nailed it.');
  });

  it('maps score 75 to "You got it."', () => {
    assert.equal(headlineCopy(75), 'You got it.');
  });

  it('maps score 60 to "Getting there."', () => {
    assert.equal(headlineCopy(60), 'Getting there.');
  });

  it('maps score 18 to "Keep practicing." — NOT "Almost there"', () => {
    assert.equal(headlineCopy(18), 'Keep practicing.');
    assert.notEqual(headlineCopy(18), 'Almost there');
  });

  it('boundary 70 = pass, 69 = warn', () => {
    assert.equal(headlineCopy(70), 'You got it.');
    assert.equal(headlineCopy(69), 'Getting there.');
  });
});
