import * as R from 'ramda';
import * as XP from 'xod-project';
import { foldMaybe, catMaybies } from 'xod-func-tools';

import * as PAT from '../project/actionTypes';
import * as EAT from '../editor/actionTypes';

import {
  generalValidator,
  callFnIfExist,
  mergeErrors,
  validatePatches,
  validateLocalPatches,
  validateChangedPatch,
  validatePatchesGenerally,
  setAssocPolicy,
  setMergePolicy,
  // Basic validate functions:
  getVariadicMarkersErrorMap,
  getDeadRefErrorMap,
  validateBoundValues,
  validateLinkPins,
} from './validators.internal';

// PinErrors :: { errors: Map ErrorType (Maybe [Error]) }
// LinkErrors :: { errors: Map ErrorType (Maybe [Error]) }
// NodeErrors :: { errors: Map ErrorType (Maybe [Error]), pins: Map PinKey PinErrors }
// PatchErrors :: { errors: Map ErrorType (Maybe [Error]), nodes: Map NodeId NodeErrors }

// =============================================================================
//
// Predicates for preventing excessive validations
// &
// Short validate functions
//
// =============================================================================

// :: Node -> Boolean
const isNodeTerminalOrSelf = R.compose(
  R.either(XP.isTerminalPatchPath, XP.isTerminalSelf),
  XP.getNodeType
);

// A map of functions, that accepts new project and action
// to check shall we need to run any validations on this changes
// Indexed by ActionTypes
// Return false to skip validation
// Map ActionType (Action -> Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors -> Boolean)
const shouldValidate = {
  [PAT.BULK_MOVE_NODES_AND_COMMENTS]: (action, project) => {
    // Could change validity only when moving terminals or `output-self` marker
    const nodeIds = action.payload.nodeIds;
    if (nodeIds.length === 0) return false;

    return R.compose(
      foldMaybe(false, XP.isVariadicPatch),
      XP.getPatchByPath(action.payload.patchPath)
    )(project);
  },
  [PAT.NODE_UPDATE_PROPERTY]: (action, project) => {
    const key = action.payload.key;
    // If User changed description — do not validate
    if (key === 'description') return false;

    const nodeId = action.payload.id;
    const patchPath = action.payload.patchPath;

    return R.compose(
      foldMaybe(
        true, // Very strange behaviour — let's validate
        R.either(
          // If changed label — do not validate
          () => key !== 'label',
          // But if it's terminal or self Node — validate
          isNodeTerminalOrSelf
        )
      ),
      R.chain(XP.getNodeById(nodeId)),
      XP.getPatchByPath
    )(patchPath, project);
  },
  [PAT.PATCH_DESCRIPTION_UPDATE]: R.F,
  [PAT.PATCH_NATIVE_IMPLEMENTATION_UPDATE]: R.F,
};

/**
 * A map of short-circuit validations and exceptions to the general rules
 * of validation.
 * For example of exception case see `PAT.PATCH_ADD`.
 *
 * Indexed by ActionTypes.
 * Should return `ErrorsUpdateData` { policy: UPDATE_ERRORS_POLICY, errors: Map PatchPath PatchErrors }
 *
 * Better and simplies way to produce this type is apply `set*Policy` function
 * as a last step of custom validation.
 * There are three policy rules:
 * `setMergePolicy`      - will merge new errors deeply inside previvous errors.
 *                         It's handy when you check only one thing, not whole
 *                         patch or patches.
 * `setAssocPolicy`      - will overwrite errors only for listed patch paths.
 *                         Use it when you validates some patches for all
 *                         possibly errors. E.G. `validateLocalPatches`.
 * `setOverwritePolicy`  - will overwrite all errors with new ones.
 *                         Use it only when you validates whole project,
 *                         including library patches.
 *
 * Signature for each function in this map:
 * :: Action -> Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors -> ErrorsUpdateData
 *
 * But there is a pack of utility functions, that make validation easier:
 *
 * To validate only one Patch, that was referenced in the Action, call:
 * validateChangedPatch :: [NodeValidateFn] -> [PinValidateFn] -> [LinkValidateFn] ->  Action -> Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors -> Map PatchPath PatchErrors
 *
 * To validate specific list of patches.
 * validatePatches :: [NodeValidateFn] -> [PinValidateFn] -> [LinkValidateFn] -> Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors -> [Patch] -> Map PatchPath PatchErrors
 *
 * To validate specific patches with default set of validating functions
 * (like `validatePatches` but with predefined arrays of functions):
 * validatePatchesGenerally :: Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors -> [Patch] -> Map PatchPath PatchErrors
 *
 * To validate all local patches with default set of validating functions:
 * validateLocalPatches :: Project -> Map PatchPath DeducedPinTypes -> Nullable PatchPath -> Map PatchPath PatchErrors -> Map PatchPath PatchErrors
 *
 *To validate all patches (including local and library) with default set:
 * validateAllPatches :: Project -> Map PatchPath DeducedPinTypes -> Nullable PatchPath -> Map PatchPath PatchErrors -> Map PatchPath PatchErrors
 *
 * Do not forget to use `set*Policy` function!
 */
const shortValidators = {
  // Exceptions from general validation pipeline

  // We have to validate all local patches,
  // cause some other patches could have dead referece errors and etc
  [PAT.PATCH_ADD]: (_, project, deducedPinTypes, prevErrors) =>
    R.compose(setAssocPolicy, validateLocalPatches)(
      project,
      deducedPinTypes,
      null,
      prevErrors
    ),
  // We have to validate all local patches,
  // cause only local patch could be renamed
  [PAT.PATCH_RENAME]: (_, project, deducedPinTypes, prevErrors) =>
    R.compose(setAssocPolicy, validateLocalPatches)(
      project,
      deducedPinTypes,
      null,
      prevErrors
    ),

  // Optimizations

  // Check only for valid variadics
  [PAT.BULK_MOVE_NODES_AND_COMMENTS]: R.compose(
    setMergePolicy,
    validateChangedPatch([getVariadicMarkersErrorMap], [], [])
  ),

  // When library installed we have to check all patches inside installed library
  // And check all errored patches, cause it could have a dependency to newly installed library
  [EAT.INSTALL_LIBRARIES_COMPLETE]: (
    action,
    project,
    deducedPinTypes,
    prevErrors
  ) => {
    const newErrorsForPrevivouslyErroredPatches = R.compose(
      validatePatches(
        [getDeadRefErrorMap],
        [validateBoundValues],
        [validateLinkPins],
        project,
        deducedPinTypes,
        prevErrors
      ),
      catMaybies,
      R.map(XP.getPatchByPath(R.__, project)),
      R.keys
    )(prevErrors);

    const installedLibNames = R.compose(
      R.map(libName => {
        // TODO: Replace with `R.takeWhile` from newer Ramda
        const index = libName.indexOf('@');
        return libName.substring(0, index !== -1 ? index : libName.length);
      }),
      R.keys,
      R.path(['payload', 'projects'])
    )(action);

    const isAmongToInstalledLibs = R.compose(R.anyPass, R.map(R.startsWith))(
      installedLibNames
    );

    const libErrors = R.compose(
      validatePatchesGenerally(project, deducedPinTypes, prevErrors),
      R.filter(R.pipe(XP.getPatchPath, isAmongToInstalledLibs)),
      XP.listPatches
    )(project);

    return R.compose(setMergePolicy, R.merge)(
      newErrorsForPrevivouslyErroredPatches,
      libErrors
    );
  },
};

// =============================================================================
//
// API
//
// =============================================================================

// Checks shall we need to run any validations in this change or not
// :: Action -> Project -> Boolean
export const shallValidate = callFnIfExist(shouldValidate, R.T);

// Validates Project
// If there is a short validator for occured action it will run this validation
// otherwise it will run a basic validation
// Result could contain
// :: Action -> Project -> Map PatchPath (Map NodeId [Error])
export const validateProject = R.curry(
  (action, newProject, deducedPinTypes, prevErrors) =>
    R.compose(
      mergeErrors(prevErrors),
      callFnIfExist(shortValidators, generalValidator)
    )(action, newProject, deducedPinTypes, prevErrors)
);
