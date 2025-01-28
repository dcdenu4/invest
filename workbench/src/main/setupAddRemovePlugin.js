import upath from 'upath';
import fs from 'fs';
import { tmpdir } from 'os';
import toml from 'toml';
import { spawn } from 'child_process';
import { app, ipcMain } from 'electron';

import { getLogger } from './logger';
import { ipcMainChannels } from './ipcMainChannels';
import { settingsStore } from './settingsStore';

const logger = getLogger(__filename.split('/').slice(-1)[0]);

/**
 * Spawn a child process and log its stdout, stderr, and any error in spawning.
 *
 * child_process.spawn is called with the provided cmd, args, and options,
 * and the windowsHide option set to true. The shell option is set to true
 * because spawn by default sets shell to false.
 *
 * Required properties missing from the store are initialized with defaults.
 * Invalid properties are reset to defaults.
 * @param  {string} cmd - command to pass to spawn
 * @param  {Array} args - command arguments to pass to spawn
 * @param  {object} options - options to pass to spawn.
 * @returns {Promise} resolves when the command finishes with exit code 0.
 *                    Rejects with error otherwise.
 */
function spawnWithLogging(cmd, args, options) {
  logger.info(cmd, args);
  const cmdProcess = spawn(
    cmd, args, { ...options, shell: true, windowsHide: true });
  if (cmdProcess.stdout) {
    cmdProcess.stderr.on('data', (data) => logger.info(data.toString()));
    cmdProcess.stdout.on('data', (data) => logger.info(data.toString()));
  }
  return new Promise((resolve, reject) => {
    cmdProcess.on('error', (err) => {
      logger.error(err);
      reject(err);
    });
    cmdProcess.on('close', (code) => {
      if (code === 0) {
        resolve(code);
      } else {
        reject(code);
      }
    });
  });
}

export function setupAddPlugin() {
  ipcMain.handle(
    ipcMainChannels.ADD_PLUGIN,
    async (e, pluginURL) => {
      try {
        logger.info('adding plugin at', pluginURL);
        const micromamba = settingsStore.get('micromamba');
        const rootPrefix = upath.join(app.getPath('userData'), 'micromamba_envs');
        const baseEnvPrefix = upath.join(rootPrefix, 'invest_base');
        // Create invest_base environment, if it doesn't already exist
        // The purpose of this environment is just to ensure that git is available
        if (!fs.existsSync(baseEnvPrefix)) {
          await spawnWithLogging(
            micromamba,
            ['create', '--yes', '--prefix', `"${baseEnvPrefix}"`, '-c', 'conda-forge', 'git']
          );
        }
        // Create a temporary directory and check out the plugin's pyproject.toml
        const tmpPluginDir = fs.mkdtempSync(upath.join(tmpdir(), 'natcap-invest-'));
        await spawnWithLogging(
          micromamba,
          ['run', '--prefix', `"${baseEnvPrefix}"`,
            'git', 'clone', '--depth', '1', '--no-checkout', pluginURL, tmpPluginDir]
        );
        await spawnWithLogging(
          micromamba,
          ['run', '--prefix', `"${baseEnvPrefix}"`, 'git', 'checkout', 'HEAD', 'pyproject.toml'],
          { cwd: tmpPluginDir }
        );
        // Read in the plugin's pyproject.toml, then delete it
        const pyprojectTOML = toml.parse(fs.readFileSync(
          upath.join(tmpPluginDir, 'pyproject.toml')
        ).toString());
        fs.rmSync(tmpPluginDir, { recursive: true, force: true });

        // Access plugin metadata from the pyproject.toml
        const pluginID = pyprojectTOML.tool.natcap.invest.model_id;
        const pluginName = pyprojectTOML.tool.natcap.invest.model_name;
        const pluginPyName = pyprojectTOML.tool.natcap.invest.pyname;
        const condaDeps = pyprojectTOML.tool.natcap.invest.conda_dependencies;

        // Create a conda env containing the plugin and its dependencies
        const envName = `invest_plugin_${pluginID}`;
        const pluginEnvPrefix = upath.join(rootPrefix, envName);
        const createCommand = [
          'create', '--yes', '--prefix', `"${pluginEnvPrefix}"`,
          '-c', 'conda-forge', 'python'];
        if (condaDeps) { // include dependencies read from pyproject.toml
          condaDeps.forEach((dep) => createCommand.push(`"${dep}"`));
        }
        await spawnWithLogging(micromamba, createCommand);
        logger.info('created micromamba env for plugin');
        await spawnWithLogging(
          micromamba,
          ['run', '--prefix', `"${pluginEnvPrefix}"`, 'pip', 'install', `git+${pluginURL}`]
        );
        logger.info('installed plugin into its env');
        // Write plugin metadata to the workbench's config.json
        logger.info('writing plugin info to settings store');
        settingsStore.set(
          `plugins.${pluginID}`,
          {
            model_name: pluginName,
            pyname: pluginPyName,
            type: 'plugin',
            source: pluginURL,
            env: pluginEnvPrefix,
          }
        );
        logger.info('successfully added plugin');
      } catch (error) {
        return error;
      }
    }
  );
}

export function setupRemovePlugin() {
  ipcMain.handle(
    ipcMainChannels.REMOVE_PLUGIN,
    async (e, pluginID) => {
      logger.info('removing plugin', pluginID);
      try {
        // Delete the plugin's conda env
        const env = settingsStore.get(`plugins.${pluginID}.env`);
        const micromamba = settingsStore.get('micromamba');
        await spawnWithLogging(micromamba, ['remove', '--yes', '--prefix', `"${env}"`, '--all']);
        // Delete the plugin's data from storage
        settingsStore.delete(`plugins.${pluginID}`);
        logger.info('successfully removed plugin');
      } catch (error) {
        logger.info('Error removing plugin:');
        logger.info(error);
      }
    }
  );
}
