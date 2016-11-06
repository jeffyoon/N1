/* eslint global-require: 0 */
/* eslint import/no-dynamic-require: 0 */
const s3 = require('s3');
const request = require('request');
const Promise = require('bluebird');
const path = require('path');
const fs = require('fs-plus');


let s3Client = null;
let packageVersion = null;
let fullVersion = null;

module.exports = (grunt) => {
  const {shouldPublishBuild, spawn} = require('./task-helpers')(grunt);

  const populateVersion = () =>
    new Promise((resolve, reject) => {
      const json = grunt.config.get('appJSON')
      const cmd = 'git';
      const args = ['rev-parse', '--short', 'HEAD'];
      return spawn({cmd, args}, (error, {stdout} = {}) => {
        if (error) {
          return reject();
        }
        const commitHash = stdout ? stdout.trim() : null;
        packageVersion = json.version;
        if (packageVersion.indexOf('-') > 0) {
          fullVersion = packageVersion;
        } else {
          fullVersion = `${packageVersion}-${commitHash}`;
        }
        return resolve();
      });
    })
  ;

  function postToSlack(msg) {
    if (!process.env.NYLAS_INTERNAL_HOOK_URL) { return Promise.resolve(); }
    return new Promise((resolve, reject) =>
      request.post({
        url: process.env.NYLAS_INTERNAL_HOOK_URL,
        json: {
          username: "Edgehill Builds",
          text: msg,
        },
      }
      , (error) => {
        return error ? reject(error) : resolve();
      })
    );
  }

  function put(localSource, destName, options = {}) {
    grunt.log.writeln(`>> Uploading ${localSource} to S3…`);

    const write = grunt.log.writeln;
    let lastPc = 0;

    const params = {
      Key: destName,
      ACL: "public-read",
      Bucket: "edgehill",
    };
    Object.assign(params, options);

    return new Promise((resolve, reject) => {
      const uploader = s3Client.uploadFile({
        localFile: localSource,
        s3Params: params,
      });
      uploader.on("error", err => reject(err));
      uploader.on("progress", () => {
        const pc = Math.round((uploader.progressAmount / uploader.progressTotal) * 100.0);
        if (pc !== lastPc) {
          lastPc = pc;
          write(`>> Uploading ${destName} ${pc}%`);
          return;
        }
      });
      uploader.on("end", data => resolve(data));
    });
  }

  function uploadToS3(filename, key) {
    const filepath = path.join(grunt.config.get('outputDir'), filename);

    grunt.log.writeln(`>> Uploading ${filename} to ${key}…`);
    return put(filepath, key).then((data) => {
      const msg = `N1 release asset uploaded: <${data.Location}|${key}>`;
      return postToSlack(msg).then(() => Promise.resolve(data));
    });
  }

  grunt.registerTask("publish-nylas-build", "Publish Nylas build", () => {
    if (!shouldPublishBuild()) { return Promise.resolve(); }

    const awsKey = process.env.AWS_ACCESS_KEY_ID != null ? process.env.AWS_ACCESS_KEY_ID : "";
    const awsSecret = process.env.AWS_SECRET_ACCESS_KEY != null ? process.env.AWS_SECRET_ACCESS_KEY : "";

    if (awsKey.length === 0) {
      grunt.fail.fatal("Please set the AWS_ACCESS_KEY_ID environment variable");
    }
    if (awsSecret.length === 0) {
      grunt.fail.fatal("Please set the AWS_SECRET_ACCESS_KEY environment variable");
    }

    s3Client = s3.createClient({
      s3Options: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        scretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const done = this.async();

    return populateVersion().then(() => {
      const uploadPromises = [];
      const outputDir = grunt.config.get('outputDir');

      if (process.platform === 'darwin') {
        uploadPromises.push(uploadToS3(`${outputDir}/N1.zip`, `${fullVersion}/${process.platform}/${process.arch}/N1.zip`));
      } else if (process.platform === 'win32') {
        uploadPromises.push(uploadToS3(`${outputDir}/RELEASES`, `${fullVersion}/${process.platform}/${process.arch}/RELEASES`));
        uploadPromises.push(uploadToS3(`${outputDir}/Nylas N1Setup.exe`, `${fullVersion}/${process.platform}/${process.arch}/N1Setup.exe`));
        uploadPromises.push(uploadToS3(`${outputDir}/nylas-${packageVersion}-full.nupkg`, `${fullVersion}/${process.platform}/${process.arch}/nylas-${packageVersion}-full.nupkg`));
      } else if (process.platform === 'linux') {
        const files = fs.readdirSync(outputDir);
        for (const file of files) {
          if (path.extname(file) === '.deb') {
            uploadPromises.push(
              uploadToS3(file, `${fullVersion}/${process.platform}-deb/${process.arch}/N1.deb`, {ContentType: "application/x-deb"})
            );
          }
          if (path.extname(file) === '.rpm') {
            uploadPromises.push(
              uploadToS3(file, `${fullVersion}/${process.platform}-rpm/${process.arch}/N1.rpm`, {ContentType: "application/x-rpm"})
            );
          }
        }
      } else {
        grunt.fail.fatal(`Unsupported platform: '${process.platform}'`);
      }

      return Promise.all(uploadPromises).then(done).catch((err) => {
        grunt.log.error(err);
        return false;
      });
    });
  });
}
