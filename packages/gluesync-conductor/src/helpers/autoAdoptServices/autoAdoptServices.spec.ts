import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasConductorTypeLabel } from './autoAdoptServices';
import { LabelPrefix } from '../../models/composeFile.model';

const TYPE_LABEL = `${LabelPrefix.CONDUCTOR}.type=agent`;

describe('hasConductorTypeLabel', () => {
  it('is false for a service that is not in the compose file', () => {
    assert.equal(hasConductorTypeLabel(undefined), false);
  });

  it('is false for a service without labels', () => {
    assert.equal(hasConductorTypeLabel({}), false);
  });

  it('finds the type label in the array form', () => {
    assert.equal(hasConductorTypeLabel({ labels: ['a=b', TYPE_LABEL] }), true);
  });

  it('finds the type label in the map form', () => {
    assert.equal(
      hasConductorTypeLabel({
        labels: { [`${LabelPrefix.CONDUCTOR}.type`]: 'agent' },
      }),
      true,
    );
  });

  it('ignores labels that are not the conductor type', () => {
    assert.equal(
      hasConductorTypeLabel({
        labels: [`${LabelPrefix.CONDUCTOR}.name=x`, 'other.type=agent'],
      }),
      false,
    );
  });
});
