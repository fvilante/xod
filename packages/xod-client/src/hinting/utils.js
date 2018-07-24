import * as R from 'ramda';
import { maybePath } from 'xod-func-tools';

// :: NodeErrors -> [Errors]
export const getAllErrorsForNode = nodeErrors =>
  R.concat(
    nodeErrors.errors,
    R.pipe(R.prop('pins'), R.values, R.pluck('errors'), R.reduce(R.concat, []))(
      nodeErrors
    )
  );

export const getActingPatchPath = maybePath(['payload', 'patchPath']);
