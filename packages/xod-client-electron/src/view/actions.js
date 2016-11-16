import R from 'ramda';
import { ipcRenderer } from 'electron';
import { addProcess, progressProcess, successProcess, deleteProcess, addConfirmation, loadProjectFromJSON } from 'xod-client';

import { getProjectPojo } from 'xod-core';
import { getWorkspace } from '../settings/selectors';
import ActionType from './actionTypes';

import { transpile, runtime } from 'xod-espruino';
import uploadToEspruino from 'xod-espruino-upload';

const processProgressed = ({
  processId,
  actionType,
  message = 'Process in progress',
  progress = 0.5,
  payload = {},
}, dispatch) => dispatch(
  progressProcess(
    processId,
    actionType,
    R.merge({
      message,
      progress,
    }, payload)
  )
);

const processCompleted = ({
  processId,
  actionType,
  message = 'Process completed!',
  notify = true,
  payload,
  onComplete = R.always(undefined),
}, dispatch) => {
  dispatch(successProcess(processId, actionType, { data: payload }));
  onComplete(payload, dispatch);
  if (notify) {
    dispatch(addConfirmation({ message }));
  }
  setTimeout(() => {
    dispatch(deleteProcess(processId, actionType));
  }, 1000);
};

const createAsyncAction = ({
  eventName,
  actionType,
  messages: {
    process: processMsg,
    complete: completeMsg,
  },
  notify,
  onComplete,
}) => opts => (dispatch, getState) => {
  const workspace = getWorkspace(getState().settings);
  const processId = dispatch(addProcess(actionType));

  ipcRenderer.once(
    `${eventName}:process`,
    (sender, payload) => processProgressed(
      { processId, actionType, message: processMsg, notify, payload },
      dispatch
    )
  );
  ipcRenderer.once(
    `${eventName}:complete`,
    (sender, payload) => {
      processCompleted(
        { processId, actionType, message: completeMsg, notify, payload, onComplete },
        dispatch
      );
    }
  );

  ipcRenderer.send(
    eventName,
    R.merge(opts, {
      workspace,
    })
  );
};

export const loadProjectList = createAsyncAction({
  eventName: 'loadProjectList',
  actionType: ActionType.LOAD_PROJECT_LIST,
  messages: {
    process: 'Receiving of project list...',
    complete: 'Project list has been received!',
  },
  notify: false,
});

export const loadProject = createAsyncAction({
  eventName: 'loadProject',
  actionType: ActionType.LOAD_PROJECT,
  messages: {
    process: 'Loading project...',
    complete: 'Project has been loaded!',
  },
  onComplete: (data, dispatch) => {
    const json = JSON.stringify(data); // @TODO: Remove excessive json stringify->parse (?)
    dispatch(
      loadProjectFromJSON(json)
    );
  },
});

export const savePatch = createAsyncAction({
  eventName: 'savePatch',
  actionType: ActionType.SAVE_PATCH,
  messages: {
    process: 'Saving in progress...',
    complete: 'Patch has been saved successfully!',
  },
});

export const saveProject = createAsyncAction({
  eventName: 'saveProject',
  actionType: ActionType.SAVE_PROJECT,
  messages: {
    process: 'Saving in progress...',
    complete: 'Project has been saved successfully!',
  },
});

export const upload = () => (dispatch, getState) => {
  const project = getProjectPojo(getState());
  const code = transpile({ project, runtime });

  const newId = dispatch(addProcess(ActionType.UPLOAD));

  const progress = (message, percentage) => dispatch(progressProcess(
    newId,
    ActionType.UPLOAD,
    {
      message,
      percentage,
    }
  ));

  const succeed = () => dispatch(successProcess(
    newId,
    ActionType.UPLOAD
  ));

  const fail = (err) => dispatch(failProcess(
    newId,
    ActionType.UPLOAD,
    { message: err.message }
  ));

  uploadToEspruino(code, progress)
    .then(succeed)
    .catch(err => {
      if (err.constructor !== Error) {
        throw err;
      }

      fail(err);
    });
};

export default {
  upload,
  savePatch,
  saveProject,
  loadProject,
  loadProjectList,
};
