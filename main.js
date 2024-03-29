const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');

try {
    const env = core.getInput('deployment-environment');
    const destPath = core.getInput('path');

    const envDir = `environment-files/${env}`;

    fs.exists(envDir, (envDirExists) => {
        if (envDirExists) {
            const webConfigFile = `${envDir}/web.config`;
            fs.exists(webConfigFile, (webConfigExists) => {
                if (webConfigExists) {
                    fs.copyFile(webConfigFile, `${destPath}/web.config`, () => {
                        console.log(`Copied ${webConfigFile} to ${destPath}/web.config.`);
                    });
                }
            });

            const appInsightsConfigFile = `${envDir}/ApplicationInsights.config`;
            fs.exists(appInsightsConfigFile, (appInsightsConfigExists) => {
                if (appInsightsConfigExists) {
                    fs.copyFile(appInsightsConfigFile, `${destPath}/ApplicationInsights.config`, () => {
                        console.log(`Copied ${appInsightsConfigFile} to ${destPath}/ApplicationInsights.config.`);
                    });
                }
            });

            const siteLicFile = `${envDir}/site.lic`;
            fs.exists(siteLicFile, (siteLicExists) => {
                if (siteLicExists) {
                    fs.copyFile(siteLicFile, `${destPath}/bin/site.lic`, () => {
                        console.log(`Copied ${siteLicFile} to ${destPath}/bin/site.lic.`);
                    });
                }
            });
        } else {
            console.log(`WARNING: The directory "environment-files/${env}" does not exist.`);
        }
    });
} catch (error) {
    core.setFailed(error.message);
}
