import * as R from 'ramda';
import { Maybe } from 'ramda-fantasy';
import * as XP from 'xod-project';
import {
  foldMaybe,
  foldEither,
  explodeMaybe,
  mergeAllWithConcat,
  notEmpty,
  failOnNothing,
} from 'xod-func-tools';

import * as PAT from '../project/actionTypes';

import { getActingPatchPath } from './utils';

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

    const patchPath = action.payload.patchPath;

    return R.compose(
      foldMaybe(true, R.any(isNodeTerminalOrSelf)),
      R.chain(
        R.pipe(
          patch => R.map(XP.getNodeById(R.__, patch), nodeIds),
          R.sequence(Maybe.of)
        )
      ),
      XP.getPatchByPath(patchPath)
    )(project);
  },
  [PAT.NODE_UPDATE_PROPERTY]: (action, project) => {
    const nodeId = action.payload.id;
    const patchPath = action.payload.patchPath;
    const key = action.payload.key;

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
};

// A map of short-circuit validations
// Indexed by ActionTypes
// Map ActionType (Action -> Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors)
const shortValidators = {};

// =============================================================================
//
// Utils
//
// =============================================================================

const callFnIfExist = R.curry(
  (fnMap, defFn, action, project, allDeducedPinTypes) =>
    R.compose(
      fn => fn(action, project, allDeducedPinTypes),
      R.defaultTo(defFn),
      R.prop(R.__, fnMap),
      R.prop('type')
    )(action)
);

// :: Map a b -> [a]
const getNilKeys = R.pipe(R.filter(R.isNil), R.keys);

// =============================================================================
//
// Validating functions for general validator
//
// =============================================================================

const getMarkerNodesErrorMap = (predicate, validator) => patch => {
  const markerNodeIds = R.compose(
    R.map(XP.getNodeId),
    R.filter(predicate),
    XP.listNodes
  )(patch);

  if (R.isEmpty(markerNodeIds)) return {};

  return foldEither(
    err =>
      R.compose(R.map(R.of), R.fromPairs, R.map(R.pair(R.__, [err])))(
        markerNodeIds
      ),
    R.always({}),
    validator(patch)
  );
};

// :: Patch -> Map NodeId [Error]
const getVariadicMarkersErrorMap = getMarkerNodesErrorMap(
  R.pipe(XP.getNodeType, XP.isVariadicPath),
  XP.validatePatchForVariadics
);

// :: Patch -> Map NodeId [Error]
const getAbstractMarkersErrorMap = getMarkerNodesErrorMap(
  R.pipe(XP.getNodeType, R.equals(XP.ABSTRACT_MARKER_PATH)),
  XP.validateAbstractPatch
);

// :: Patch -> Map NodeId [Error]
const getConstructorMarkersErrorMap = getMarkerNodesErrorMap(
  R.pipe(XP.getNodeType, R.equals(XP.OUTPUT_SELF_PATH)),
  XP.validateConstructorPatch
);

// :: Patch -> Map NodeId [Error]
const getTerminalsErrorMap = R.compose(
  foldEither(
    err =>
      R.compose(
        R.map(R.of),
        R.fromPairs,
        R.map(R.pair(R.__, err)),
        R.path(['payload', 'pinKeys']) // those are affected terminal node ids
      )(err),
    R.always({})
  ),
  XP.validatePinLabels
);

// TODO: Use validator from xod-project after refactoring
// :: Project -> Patch -> Map NodeId [Error]
const getDeadRefErrorMap = (project, patch) =>
  R.compose(
    R.reject(R.isEmpty),
    R.map(
      R.compose(
        foldEither(R.of, R.always([])),
        nodeType => {
          const patchPath = XP.getPatchPath(patch);
          return failOnNothing('DEAD_REFERENCE__PATCH_FOR_NODE_NOT_FOUND', {
            nodeType,
            patchPath,
            trace: [patchPath],
          })(XP.getPatchByPath(nodeType, project));
        },
        XP.getNodeType
      )
    ),
    R.indexBy(XP.getNodeId),
    XP.listNodes
  )(patch);

// :: Project -> Patch -> Node -> Map PinKey PinErrors
const getPinErrors = R.curry((project, patch, node) =>
  R.compose(
    R.map(
      R.compose(
        R.objOf('errors'),
        foldEither(R.pipe(R.identity, R.of), R.always({}))
      )
    ),
    XP.getInvalidBoundNodePins
  )(project, patch, node)
);

// :: Project -> Patch -> Map NodeId NodeErrors
const getNodeErrors = R.curry((project, patch) =>
  R.compose(
    R.map(R.merge({ errors: [], pins: {} })),
    // :: Map NodeId NodeErrors
    nodeErrorsMap =>
      R.compose(
        R.merge(nodeErrorsMap),
        // :: Map NodeId { pins: Map PinKey PinErrors }
        R.map(R.objOf('pins')),
        R.reject(R.isEmpty),
        R.map(getPinErrors(project, patch)),
        R.indexBy(XP.getNodeId),
        XP.listNodes
      )(patch),
    // :: Map NodeId { errors: [Error], pins: {} }
    R.map(R.objOf('errors')),
    R.reject(R.isEmpty),
    // :: Map NodeId [Error]
    () =>
      mergeAllWithConcat([
        getDeadRefErrorMap(project, patch),
        getTerminalsErrorMap(patch),
        getVariadicMarkersErrorMap(patch),
        getAbstractMarkersErrorMap(patch),
        getConstructorMarkersErrorMap(patch),
      ])
  )()
);

// :: Project -> Patch -> Map PatchPath DeducedPinTypes -> Map LinkId LinkErrors
const getLinkErrors = R.curry((project, patch, allDeducedPinTypes) =>
  R.compose(
    R.map(R.objOf('errors')),
    R.reject(R.isEmpty),
    R.map(
      R.compose(
        foldEither(R.of, R.always([])),
        XP.validateLinkPins(
          R.__,
          patch,
          project,
          R.propOr({}, XP.getPatchPath(patch), allDeducedPinTypes)
        )
      )
    ),
    R.indexBy(XP.getLinkId),
    XP.listLinks
  )(patch)
);

// :: Project -> Patch -> { nodes: NodeErrors }
const getNodeErrorsForPatch = R.compose(R.objOf('nodes'), getNodeErrors);
// :: Project -> Patch -> Map PatchPath DeducedPinTypes -> { nodes: NodeErrors }
const getLinkErrorsForPatch = R.compose(R.objOf('links'), getLinkErrors);

// :: Project -> Map PatchPath DeducedPinTypes -> [Patch] -> Map PatchPath (Map NodeId [Error])
const validatePatches = R.curry((project, allDeducedPinTypes, patches) =>
  R.compose(
    R.reject(
      R.allPass([
        R.pipe(R.prop('errors'), R.isEmpty),
        R.pipe(R.prop('nodes'), R.isEmpty),
        R.pipe(R.prop('links'), R.isEmpty),
      ])
    ),
    R.map(patch =>
      R.mergeAll([
        { errors: [], nodes: {}, links: {} },
        getLinkErrorsForPatch(project, patch, allDeducedPinTypes),
        getNodeErrorsForPatch(project, patch),
      ])
    ),
    R.indexBy(XP.getPatchPath)
  )(patches)
);

// :: Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors
const validateLocalPatches = (project, allDeducedPinTypes) =>
  R.compose(validatePatches(project, allDeducedPinTypes), XP.listLocalPatches)(
    project
  );

// :: Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors
const validateAllPatches = (project, allDeducedPinTypes) =>
  R.compose(validatePatches(project, allDeducedPinTypes), XP.listPatches)(
    project
  );

// :: Action -> Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors
const generalValidator = (action, project, allDeducedPinTypes) => {
  const maybePatchPath = getActingPatchPath(action);
  if (Maybe.isJust(maybePatchPath)) {
    const patchPath = explodeMaybe('IMPOSSIBLE ERROR', maybePatchPath);
    return R.compose(
      R.compose(
        R.ifElse(
          notEmpty,
          () =>
            XP.isPathLocal(patchPath)
              ? validateLocalPatches(project, allDeducedPinTypes)
              : validateAllPatches(project, allDeducedPinTypes),
          R.always({ [patchPath]: null }) // If valid — omit it
        ),
        // TODO: Do not check this patch again!
        validatePatches(project, allDeducedPinTypes),
        R.of
      ),
      XP.getPatchByPathUnsafe
    )(patchPath, project);
  }

  return validateAllPatches(project, allDeducedPinTypes);
};

// :: Map PatchPath (Map NodeId [Error]) -> Map PatchPath PatchErrors
const mergeErrors = R.curry((prevErrors, nextErrors) => {
  const patchPathsToOmit = getNilKeys(nextErrors);
  return R.compose(R.omit(patchPathsToOmit), R.merge)(prevErrors, nextErrors);
});

// Validates Project
// If there is a short validator for occured action it will run this validation
// otherwise it will run a basic validation
// Result could contain
// :: Action -> Project -> Map PatchPath (Map NodeId [Error])
const validateForNewErrors = callFnIfExist(shortValidators, generalValidator);

// =============================================================================
//
// API
//
// =============================================================================

// Checks shall we need to run any validations in this change or not
// :: Action -> Project -> Boolean
export const shallValidate = callFnIfExist(predicates, R.T);

export const validateProject = R.curry(
  (action, newProject, deducedPinTypes, prevErrors) =>
    R.compose(mergeErrors(prevErrors), validateForNewErrors)(
      action,
      newProject,
      deducedPinTypes
    )
);