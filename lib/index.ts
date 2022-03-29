"use strict";

import fse from "fs-extra";
import BbPromise from "bluebird";
import _ from "lodash";
import Path from "path";
import ChildProcess from "child_process";
import zipper from "zip-local";
import upath from "upath";
import readLineSync from "readline-sync";

BbPromise.promisifyAll(fse);

const fullPluginName = "dependency_layer_packager";
const configPluginName = "dependencyLayer";

interface DependencyLayerConfig {
  playbooksFolder: string;
  requirementsFile: string;
  globalRequirements: string[];
  globalIncludes: string[];
  buildDir: string;
  containerName: string;
  cleanup: boolean;
  dockerEnvs: string[];
  mountSSH: boolean;
  dockerImage: string;
}

class DependencyLayerPackager {
  sls: any;
  options: any;
  hooks: object;
  pluginConfig: DependencyLayerConfig;
  dockerServicePath = "/var/task";

  constructor(serverless, options) {
    this.sls = serverless;
    this.options = options;
    this.pluginConfig = this.getPluginConfig();
    this.hooks = {
      "before:package:createDeploymentArtifacts": () =>
        BbPromise.bind(this)
          // .then(this.fetchConfig)
          .then(this.autoconfigArtifacts)
          .then(() => {
            fse.ensureDir(this.pluginConfig.buildDir);
          })
          .then(this.setupDocker)
          .then(this.selectAll)
          .map(this.makePackage),

      "after:deploy:deploy": () => BbPromise.bind(this).then(this.clean),
    };
  }

  error = (msg) => {
    throw new Error(`[${fullPluginName}] ${msg}`);
  };

  log = (msg) => {
    this.sls.cli.log(`[${fullPluginName}] ${msg}`);
  };

  getPluginConfig(): DependencyLayerConfig {
    const config = this.sls.service.custom[configPluginName] || {};
    if (!config) {
      this.error(`No ${fullPluginName} configuration detected. Please see documentation`);
    }

    config.requirementsFile = config.requirementsFile || "requirements.txt";
    config.globalRequirements = config.globalRequirements || ["./functions/requirements.txt"];
    config.buildDir = config.buildDir || this.error("No buildDir configuration specified");
    config.globalIncludes = config.globalIncludes || ["./common_files"];
    // config.cleanup === undefined ? this.cleanup = true : this.cleanup = config.cleanup
    // this.useDocker = config.useDocker || true
    config.dockerImage =
      config.dockerImage || `lambci/lambda:build-${this.sls.service.provider.runtime}`;
    config.containerName = config.containerName || fullPluginName;
    config.mountSSH = config.mountSSH || false;
    config.dockerEnvs = config.dockerEnvs || [];
    config.abortOnPackagingErrors = config.abortOnPackagingErrors || true;
    config.dockerServicePath = "/var/task";

    return config;
  }

  clean() {
    if (!this.pluginConfig.cleanup) {
      this.log(
        'Cleanup is set to "false". Build directory and Docker container (if used) will be retained'
      );
      return false;
    }
    this.log("Cleaning build directory...");
    fse.remove(this.pluginConfig.buildDir).catch((err) => {
      this.log(err);
    });

    // if (this.pluginConfig.useDocker) {
    this.log("Removing Docker container...");
    this.runProcess("docker", ["stop", this.pluginConfig.containerName, "-t", "0"]);
    // }
    return true;
  }

  runProcess(cmd, args) {
    const ret = ChildProcess.spawnSync(cmd, args);
    if (ret.error) {
      throw new this.sls.classes.Error(`[${fullPluginName}] ${ret.error.message}`);
    }

    const out = ret.stdout.toString();

    if (ret.stderr.length != 0) {
      const errorText = ret.stderr.toString().trim();
      this.log(errorText); // prints stderr

      // if (this.pluginConfig.abortOnPackagingErrors) {
      const countErrorNewLines = errorText.split("\n").length;

      if (
        !errorText.includes("ERROR:") &&
        countErrorNewLines < 2 &&
        errorText.toLowerCase().includes("git clone")
      ) {
        // Ignore false positive due to pip git clone printing to stderr
      } else if (
        errorText.toLowerCase().includes("warning") &&
        !errorText.toLowerCase().includes("error")
      ) {
        // Ignore warnings
      } else if (errorText.toLowerCase().includes("docker")) {
        console.log("stdout:", out);
        this.error("Docker Error Detected");
      } else {
        // Error is not false positive,
        console.log("___ERROR DETECTED, BEGIN STDOUT____\n", out);
        this.requestUserConfirmation();
      }
      // }
    }

    return out;
  }

  requestUserConfirmation(
    prompt = "\n\n??? Do you wish to continue deployment with the stated errors? \n",
    yesText = "Continuing Deployment!",
    noText = "ABORTING DEPLOYMENT"
  ) {
    const response = readLineSync.question(prompt);
    if (response.toLowerCase().includes("y")) {
      console.log(yesText);
      return;
    } else {
      console.log(noText);
      this.error("Aborting");
      return;
    }
  }

  // selectAll() {
  //   const functions = _.reject(this.sls.service.functions, (target) => {
  //     return target.runtime && !(target.runtime + "").match(/python/i);
  //   });

  //   const info = _.map(functions, (target) => {
  //     return {
  //       name: target.name,
  //       includes: target.package.include,
  //       artifact: target.package.artifact,
  //     };
  //   });
  //   return info;
  // }

  selectAll(): Record<string, string>[] {
    // const layers = _.reject(this.sls.service.layers, (target) => {
    //   return target.runtime && !(target.runtime + "").match(/python/i);
    // });

    const layers = this.sls.service.layers;

    const info = _.map(layers, (target) => {
      return {
        path: target.path, // layer directory
        compatibleRuntimes: target.compatibleRuntimes,
        compatibleArchitectures: target.compatibleArchitectures,
        name: target.name,
        // includes: target.package.include,
        // artifact: target.package.artifact,
      };
    });
    return info;
  }

  installRequirements(buildPath, requirementsPath) {
    if (!fse.pathExistsSync(requirementsPath)) {
      return;
    }
    const size = fse.statSync(requirementsPath).size;

    if (size === 0) {
      this.log(`WARNING: requirements file at ${requirementsPath} is empty. Skiping.`);
      return;
    }

    let cmd = "pip";
    let args = ["install", "--upgrade", "-t", upath.normalize(buildPath), "-r"];
    // if (this.pluginConfig.useDocker === true) {
    cmd = "docker";
    args = ["exec", this.pluginConfig.containerName, "pip", ...args];
    requirementsPath = `${this.dockerServicePath}/${requirementsPath}`;
    // }

    args = [...args, upath.normalize(requirementsPath)];
    return this.runProcess(cmd, args);
  }

  checkDocker() {
    const out = this.runProcess("docker", [
      "version",
      "-f",
      "Server Version {{.Server.Version}} & Client Version {{.Client.Version}}",
    ]);
    this.log(`Using Docker ${out}`);
  }

  autoconfigArtifacts() {
    _.map(this.sls.service.functions, (func_config, func_name) => {
      let autoArtifact = `${this.pluginConfig.buildDir}/${func_config.name}.zip`;
      func_config.package.artifact = func_config.package.artifact || autoArtifact;
      this.sls.service.functions[func_name] = func_config;
    });
  }

  setupContainer() {
    let out = this.runProcess("docker", [
      "ps",
      "-a",
      "--filter",
      `name=${this.pluginConfig.containerName}`,
      "--format",
      "{{.Names}}",
    ]);
    out = out.replace(/^\s+|\s+$/g, "");

    if (out === this.pluginConfig.containerName) {
      this.log("Container already exists. Killing it and reusing.");
      let out = this.runProcess("docker", ["kill", `${this.pluginConfig.containerName}`]);
      this.log(out);
    }

    let args = ["run", "--rm", "-dt", "-v", `${process.cwd()}:${this.dockerServicePath}`];

    // Add any environment variables to docker run cmd
    this.pluginConfig.dockerEnvs.forEach(function (envVar) {
      args.push("-e", envVar);
    });

    if (this.pluginConfig.mountSSH) {
      args = args.concat(["-v", `${process.env.HOME}/.ssh:/root/.ssh`]);
    }

    args = args.concat([
      "--name",
      this.pluginConfig.containerName,
      this.pluginConfig.dockerImage,
      "bash",
    ]);
    this.runProcess("docker", args);
    this.log("Container created");
  }

  ensureImage() {
    const out = this.runProcess("docker", [
      "images",
      "--format",
      "{{.Repository}}:{{.Tag}}",
      "--filter",
      `reference=${this.pluginConfig.dockerImage}`,
    ]).replace(/^\s+|\s+$/g, "");
    if (out != this.pluginConfig.dockerImage) {
      this.log(
        `Docker Image ${this.pluginConfig.dockerImage} is not already installed on your system. Downloading. This might take a while. Subsequent deploys will be faster...`
      );
      this.runProcess("docker", ["pull", this.pluginConfig.dockerImage]);
    }
  }
  setupDocker() {
    // if (!this.useDocker) {
    //   return;
    // }
    this.log("Packaging using Docker container...");
    this.checkDocker();
    this.ensureImage();
    this.log(`Creating Docker container "${this.pluginConfig.containerName}"...`);
    this.setupContainer();
    this.log("Docker setup completed");
  }

  makePackage(target) {
    this.log(`Packaging ${target.name}...`);
    const buildPath = Path.join(this.pluginConfig.buildDir, target.name);
    const requirementsPath = Path.join(buildPath, this.pluginConfig.requirementsFile);
    // Create package directory and package files
    fse.ensureDirSync(buildPath);
    // Copy includes
    let includes = target.includes || [];
    includes = includes.concat(this.pluginConfig.globalIncludes);

    includes.forEach((item) => {
      if (fse.existsSync(item)) {
        fse.copySync(item, buildPath);
      }
    });

    // Install requirements
    let requirementsFiles = [requirementsPath];
    requirementsFiles = requirementsFiles.concat(this.pluginConfig.globalRequirements);

    requirementsFiles.forEach((req) => {
      if (fse.existsSync(req)) {
        this.installRequirements(buildPath, req);
      }
    });
    zipper.sync.zip(buildPath).compress().save(`${buildPath}.zip`);
  }
}

export = DependencyLayerPackager;
