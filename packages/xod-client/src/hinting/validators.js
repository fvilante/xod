import * as R from 'ramda';
import * as XP from 'xod-project';
import { foldMaybe } from 'xod-func-tools';

import * as PAT from '../project/actionTypes';

import {
  generalValidator,
  callFnIfExist,
  mergeErrors,
  validate,
  // Basic validate functions:
  getVariadicMarkersErrorMap,
} from './validators.internal';

// PinErrors :: { errors: [Error] } | {}
// LinkErrors :: { errors: [Error] } | {}
// NodeErrors :: { errors: [Error], pins: Map PinKey PinErrors } | {}
// PatchErrors :: { errors: [Error], nodes: Map NodeId NodeErrors } | {}

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
// Map ActionType (Action -> Project -> Map PatchPath DeducedPinTypes -> Boolean)
const predicates = {
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

// A map of short-circuit validations
// Indexed by ActionTypes
const shortValidators = {
  /**
   * validate(
   *   // Validates Nodes with
   *   [ (Patch -> Project -> Map NodeId [Error]) ],
   *   // Validates Pins with
   *   [ (Patch -> Project -> Map PinKey PinErrors) ],
   *   // Validates Links with
   *   [ (Link -> Patch -> Project -> Map PatchPath DeducedPinTypes -> [Error]) ]
   * )
   */
  // Check only for valid variadics
  [PAT.BULK_MOVE_NODES_AND_COMMENTS]: validate([
    [getVariadicMarkersErrorMap],
    [],
    [],
  ]),
};

// =============================================================================
//
// API
//
// =============================================================================

// Checks shall we need to run any validations in this change or not
// :: Action -> Project -> Boolean
export const shallValidate = callFnIfExist(predicates, R.T);

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
    )(action, newProject, deducedPinTypes)
);
