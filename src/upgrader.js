const Emitter = require('events');
const fs = require('fs-extra');
const path = require('path');
const request = require('request');
const progress = require('request-progress');
const hashFiles = require('hash-files');
const extract = require('extract-zip');
const fetch = require('node-fetch');
const parseMessage = require('openblock-parse-release-message');
const byteSize = require('byte-size');
const clc = require('cli-color');

const {UPGRADE_STEP, CONTENT} = require('./state');
const {checkDirHash} = require('./calc-dir-hash');
const {formatTime} = require('./format');
const {DIRECTORY_NAME} = require('./config');
const getConfigHash = require('./get-config-hash');

class ResourceUpgrader extends Emitter{
    constructor (repo, cdn, workDir) {
        super();

        this._repo = repo;
        this._cdn = cdn;
        this._workDir = workDir;
    }

    getLatest () {
        let url = `https://api.github.com/repos/${this._repo}/releases/latest`;

        if (this._cdn) {
            url = `${this._cdn}/${url}`;
        }

        return new Promise((resolve, reject) => {
            fetch(url)
                .then(res => resolve(res.json()))
                .catch(err => reject(err));
        });
    }

    checkUpdate () {
        return new Promise((resolve, reject) => {
            this.getLatest(this._repo, this._cdn)
                .then(info => {
                    if (info.tag_name) {
                        const version = info.tag_name;
                        const message = parseMessage(info.body);

                        return resolve({latestVersion: version, message: message});
                    }
                    return reject(`Cannot get valid releases from: ${this._repo}`);
                })
                .catch(err => reject(err));
        });
    }

    download (url, dest, callback) {
        if (this._cdn) {
            url = `${this._cdn}/${url}`;
        }
        return new Promise((resolve, reject) => {
            progress(request(url))
                .on('progress', state => {
                    if (callback) {
                        callback({
                            phase: UPGRADE_STEP.downloading,
                            info: {
                                name: path.basename(dest),
                                percent: state.percent, // 0 ~ 1
                                speed: `${byteSize(state.speed)}/s`,
                                total: `${byteSize(state.size.total)}`,
                                transferred: `${byteSize(state.size.transferred)}`,
                                remaining: formatTime(state.time.remaining)
                            }
                        });
                    }
                })
                .on('error', err => reject(err))
                .on('end', () => resolve())
                .pipe(fs.createWriteStream(dest));
        });
    }

    upgrade (version, callback) {
        const downloadPath = path.resolve(this._workDir, 'download');
        fs.ensureDirSync(downloadPath);

        const shortVersion = version.replace(/v/g, '');

        const resourceName = `external-resources-${shortVersion}.zip`;
        const resourceUrl = `https://github.com/openblockcc/external-resources-v2/releases/download/${version}/${resourceName}`;
        const resourcePath = path.join(downloadPath, resourceName);

        const checksumName = `${shortVersion}-checksums-sha256.txt`;
        const checksumUrl = `https://github.com/openblockcc/external-resources-v2/releases/download/${version}/${checksumName}`;
        const checksumPath = path.join(downloadPath, checksumName);

        // Step 1: download zip and checksun file.
        return this.download(resourceUrl, resourcePath, callback)
            .then(() => this.download(checksumUrl, checksumPath, callback))
            .then(() => {
                // Step 2: check checksum of zip.
                if (callback){
                    callback({
                        phase: UPGRADE_STEP.checking,
                        info: {name: CONTENT.downloadedFile}
                    });
                }
                const zipChecksum = fs.readFileSync(checksumPath, 'utf8').split('  ')[0];
                const hash = hashFiles.sync({files: resourcePath, algorithm: 'sha256'});

                if (zipChecksum === hash) {
                    // Step 3: delete old directory.
                    const extractPath = path.resolve(this._workDir, DIRECTORY_NAME);
                    if (callback) {
                        callback({
                            phase: UPGRADE_STEP.deleting,
                            info: {name: CONTENT.userDirectory}
                        });
                    }
                    fs.rmSync(extractPath, {recursive: true, force: true});

                    // Step 4: extract zip.
                    if (callback) {
                        callback({
                            phase: UPGRADE_STEP.extracting
                        });
                    }
                    return extract(resourcePath, {dir: extractPath})
                        .then(() => {
                            // Step 5: check checksum of extracted directory.
                            if (callback) {
                                callback({
                                    phase: UPGRADE_STEP.checking,
                                    info: {name: CONTENT.userDirectory}
                                });
                            }

                            const configFilePath = path.resolve(extractPath, 'config.json');
                            const dirHash = getConfigHash(configFilePath);
                            if (!dirHash) {
                                console.warn(clc.yellow(`WARN: no hash value found in ${configFilePath}`));
                                return Promise.resolve();
                            }
                            return checkDirHash(extractPath, dirHash);
                        })
                        .then(() => {
                            // Step 6.1: delete downloaded files.
                            if (callback) {
                                callback({
                                    phase: UPGRADE_STEP.deleting,
                                    info: {name: CONTENT.downloadedFile}
                                });
                            }

                            fs.rmSync(resourcePath, {recursive: true, force: true});
                            fs.rmSync(checksumPath, {recursive: true, force: true});
                        })
                        .catch(err => {
                            // Step 6.2: if check failed, delete extracted directory.
                            if (callback) {
                                callback({
                                    phase: UPGRADE_STEP.deleting,
                                    info: {name: CONTENT.userDirectory}
                                });
                            }
                            fs.rmSync(extractPath, {recursive: true, force: true});
                            return Promise.reject(err);
                        });
                }
                return Promise.reject(`${resourcePath} has failed the checksum detection`);
            });
    }
}

module.exports = ResourceUpgrader;