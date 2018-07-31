import * as R from 'ramda';
import { Maybe } from 'ramda-fantasy';
import * as XP from 'xod-project';
import {
  foldEither,
  explodeMaybe,
  mergeAllWithConcat,
  catMaybies,
  failOnNothing,
  concatLists,
} from 'xod-func-tools';

import { getActingPatchPath } from './utils';

// PinValidateFn :: Patch -> Project -> Map PinKey PinErrors
// NodeValidateFn :: Patch -> Project -> Map NodeId [Error]
// LinkValidateFn :: Link -> Patch -> Project -> Map PatchPath DeducedPinTypes -> [Error]

// =============================================================================
//
// Basic validate functions
//
// =============================================================================

export const getMarkerNodesErrorMap = (predicate, validator) => patch => {
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
export const getVariadicMarkersErrorMap = getMarkerNodesErrorMap(
  R.pipe(XP.getNodeType, XP.isVariadicPath),
  XP.validatePatchForVariadics
);

// :: Patch -> Map NodeId [Error]
export const getAbstractMarkersErrorMap = getMarkerNodesErrorMap(
  R.pipe(XP.getNodeType, R.equals(XP.ABSTRACT_MARKER_PATH)),
  XP.validateAbstractPatch
);

// :: Patch -> Map NodeId [Error]
export const getConstructorMarkersErrorMap = getMarkerNodesErrorMap(
  R.pipe(XP.getNodeType, R.equals(XP.OUTPUT_SELF_PATH)),
  XP.validateConstructorPatch
);

// :: Patch -> Map NodeId [Error]
export const getTerminalsErrorMap = R.compose(
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
// :: Patch -> Project -> Map NodeId [Error]
export const getDeadRefErrorMap = (patch, project) =>
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

// :: Patch -> Project -> Node -> Map PinKey PinErrors
export const validateBoundValues = R.curry((patch, project, node) =>
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

// :: Link -> Patch -> Project -> Map PatchPath DeducedPinTypes -> [Error]
const validateLinkPins = R.curry((link, patch, project, allDeducedPinTypes) =>
  R.compose(
    foldEither(R.of, R.always([])),
    XP.validateLinkPins(link, patch, project),
    R.propOr({}, XP.getPatchPath(patch))
  )(allDeducedPinTypes)
);

// =============================================================================
//
// Utility functions to run validations properly
//
// =============================================================================

// :: Map a (Maybe b) -> [a]
const getKeysOfNothing = R.pipe(R.filter(Maybe.isNothing), R.keys);

// :: [NodeValidateFn] -> Patch -> Project -> Map PatchPath PatchErrors -> Map NodeId NodeErrors
const validateNodes = R.curry(
  (nodeValidators, pinValidators, patch, project, prevErrors) =>
    R.compose(
      R.map(R.merge({ errors: [], pins: {} })),
      // :: Map NodeId NodeErrors
      nodeErrorsMap =>
        R.compose(
          R.merge(nodeErrorsMap),
          // :: Map NodeId { pins: Map PinKey PinErrors }
          R.map(R.objOf('pins')),
          R.reject(R.isEmpty),
          R.map(node =>
            R.compose(
              mergeAllWithConcat,
              R.map(fn => fn(patch, project, node, prevErrors))
            )(pinValidators)
          ),
          R.indexBy(XP.getNodeId),
          XP.listNodes
        )(patch),
      // :: Map NodeId { errors: [Error], pins: {} }
      R.map(R.objOf('errors')),
      R.reject(R.isEmpty),
      // :: Map NodeId [Error]
      mergeAllWithConcat,
      R.map(fn => fn(patch, project, prevErrors))
    )(nodeValidators)
);

// :: [LinkValidateFn] -> Patch -> Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors -> Map LinkId LinkErrors
const validateLinks = R.curry(
  (validators, patch, project, allDeducedPinTypes, prevErrors) =>
    R.compose(
      R.map(R.objOf('errors')),
      R.reject(R.isEmpty),
      R.map(link =>
        R.compose(
          concatLists,
          R.map(fn => fn(link, patch, project, allDeducedPinTypes, prevErrors))
        )(validators)
      ),
      R.indexBy(XP.getLinkId),
      XP.listLinks
    )(patch)
);

// :: [NodeValidateFn] -> [PinValidateFn] -> Patch -> Project -> Map PatchPath PatchErrors -> { nodes: NodeErrors }
const getNodeErrors = R.curry(
  (nodeValidators, pinValidators, patch, project, prevErrors) =>
    R.compose(R.objOf('nodes'), validateNodes(nodeValidators, pinValidators))(
      patch,
      project,
      prevErrors
    )
);
// :: [LinkValidateFn] -> Patch -> Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors -> { nodes: NodeErrors }
const getLinkErrors = R.curry(
  (linkValidators, patch, project, allDeducedPinTypes, prevErrors) =>
    R.compose(R.objOf('links'), validateLinks(linkValidators))(
      patch,
      project,
      allDeducedPinTypes,
      prevErrors
    )
);

// :: [NodeValidateFn] -> [PinValidateFn] -> [LinkValidateFn] -> Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors -> [Patch] -> Map PatchPath (Maybe PatchErrors)
export const validatePatches = R.curry(
  (
    nodeValidators,
    pinValidators,
    linkValidators,
    project,
    allDeducedPinTypes,
    prevErrors,
    patches
  ) =>
    R.compose(
      R.map(
        R.ifElse(
          R.allPass([
            R.pipe(R.prop('errors'), R.isEmpty),
            R.pipe(R.prop('nodes'), R.isEmpty),
            R.pipe(R.prop('links'), R.isEmpty),
          ]),
          Maybe.Nothing,
          Maybe.of
        )
      ),
      R.map(patch =>
        R.mergeAll([
          { errors: [], nodes: {}, links: {} },
          getLinkErrors(
            linkValidators,
            patch,
            project,
            allDeducedPinTypes,
            prevErrors
          ),
          getNodeErrors(
            nodeValidators,
            pinValidators,
            patch,
            project,
            prevErrors
          ),
        ])
      ),
      R.indexBy(XP.getPatchPath)
    )(patches)
);

// :: Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors -> [Patch] -> Map PatchPath (Maybe PatchErrors)
export const validatePatchesGenerally = validatePatches(
  [
    getDeadRefErrorMap,
    getTerminalsErrorMap,
    getVariadicMarkersErrorMap,
    getAbstractMarkersErrorMap,
    getConstructorMarkersErrorMap,
  ],
  [validateBoundValues],
  [validateLinkPins]
);

// :: PatchPath -> [Patch] -> [Patch]
const filterPatchAndDependentPatchesByPatchPath = R.curry(
  (patchPath, patches) =>
    R.when(
      () => patchPath,
      R.filter(
        R.either(
          XP.hasNodeWithType(patchPath),
          R.pipe(XP.getPatchPath, R.equals(patchPath))
        )
      )
    )(patches)
);

// :: Project -> Map PatchPath DeducedPinTypes -> Nullable PatchPath -> Map PatchPath PatchErrors -> Map PatchPath (Maybe PatchErrors)
const validateLocalPatches = (
  project,
  allDeducedPinTypes,
  changedPatchPath,
  prevErrors
) =>
  R.compose(
    validatePatchesGenerally(project, allDeducedPinTypes, prevErrors),
    filterPatchAndDependentPatchesByPatchPath(changedPatchPath),
    XP.listLocalPatches
  )(project);

// :: Project -> Map PatchPath DeducedPinTypes -> Nullable PatchPath -> Map PatchPath PatchErrors -> Map PatchPath (Maybe PatchErrors)
const validateAllPatches = (
  project,
  allDeducedPinTypes,
  changedPatchPath,
  prevErrors
) =>
  R.compose(
    validatePatchesGenerally(project, allDeducedPinTypes, prevErrors),
    filterPatchAndDependentPatchesByPatchPath(changedPatchPath),
    XP.listPatches
  )(project);

// =============================================================================
//
// API
//
// =============================================================================

export const callFnIfExist = R.curry(
  (fnMap, defFn, action, project, allDeducedPinTypes, prevErrors) =>
    R.compose(
      fn => fn(action, project, allDeducedPinTypes, prevErrors),
      R.defaultTo(defFn),
      R.prop(R.__, fnMap),
      R.prop('type')
    )(action)
);

// :: Action -> Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors -> Map PatchPath (Maybe PatchErrors)
export const generalValidator = (
  action,
  project,
  allDeducedPinTypes,
  prevErrors
) => {
  const maybePatchPath = getActingPatchPath(action);
  if (Maybe.isJust(maybePatchPath)) {
    const patchPath = explodeMaybe('IMPOSSIBLE ERROR', maybePatchPath);
    return R.compose(
      R.compose(
        R.when(
          R.pipe(R.values, R.head, Maybe.isJust),
          () =>
            XP.isPathLocal(patchPath)
              ? validateLocalPatches(
                  project,
                  allDeducedPinTypes,
                  patchPath,
                  prevErrors
                )
              : validateAllPatches(
                  project,
                  allDeducedPinTypes,
                  patchPath,
                  prevErrors
                )
        ),
        validatePatchesGenerally(project, allDeducedPinTypes, prevErrors),
        R.of
      ),
      XP.getPatchByPathUnsafe
    )(patchPath, project);
  }

  return validateAllPatches(project, allDeducedPinTypes, null, prevErrors);
};

// :: Map PatchPath (Map NodeId [Error]) -> Map PatchPath PatchErrors
export const mergeErrors = R.curry((prevErrors, nextErrors) => {
  const patchPathsToOmit = getKeysOfNothing(nextErrors);
  return R.merge(R.omit(patchPathsToOmit, prevErrors), catMaybies(nextErrors));
});

// :: [NodeValidateFn] -> [PinValidateFn] -> [LinkValidateFn] ->  Action -> Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors -> Map PatchPath (Maybe PatchErrors)
export const validatePatchByAction = R.curry(
  (
    nodeValidators,
    pinValidators,
    linkValidators,
    action,
    project,
    allDeducedPinTypes,
    prevErrors
  ) => {
    const validateFn = validatePatches(
      [R.always({}), ...nodeValidators],
      [R.always({}), ...pinValidators],
      [R.always([]), ...linkValidators]
    );

    const maybePatchPath = getActingPatchPath(action);
    if (Maybe.isJust(maybePatchPath)) {
      const patchPath = explodeMaybe('IMPOSSIBLE ERROR', maybePatchPath);
      return R.compose(
        validateFn(project, allDeducedPinTypes, prevErrors),
        R.of,
        XP.getPatchByPathUnsafe
      )(patchPath, project);
    }

    return validateAllPatches(project, allDeducedPinTypes, prevErrors);
  }
);
