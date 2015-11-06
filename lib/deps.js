/* global process, module */
var realFs     = require('fs');
var fs         = require('q-io/fs');
var exec       = require('child_process').exec;
var Q          = require('q');
var path       = require('path');

var DEPS_FOLDER = 'deps/';

var exists = function(pth) {
  try {
    realFs.statSync(pth);
  } catch (e) {
    return false;
  }
  return true;
};

/**
 * git clone or update a dependecy with git pull
 * Dependencies are placed in test/deps/
 * @param {String} name The name of the component
 * @value {String} value (optional) URL to component
 * @return {Promise} a promise that resolves when everything is up to date.
 */
var alreadyUpdated = {};
var updateDependency = function(name, value) {

  if (!alreadyUpdated[name]) {
    var deferred = Q.defer();
    console.log('Checking dependency ' + name);

    var pth = path.join(process.cwd(), DEPS_FOLDER + name);

    //Have we aldready cloned the repo?
    var cmd = 'git pull';
    var cwd = pth;
    if (!exists(pth)) {
      var groupMap = {
        'tws': 'textalk-webshop-native-components/',
        'tc': 'textalk-custom-components/'
      };
      var group = groupMap[name.split('-')[0]];

      var url = 'http://git.diversity.io/' + group +
                name + '.git ';
      if (/^(https{0,1}:\/\/|\/\/|git).*/.test(value)) {
        url = value;
      }
      cmd = 'git clone ' + url;
      cwd = path.join(process.cwd(), DEPS_FOLDER);
    }
    alreadyUpdated[name] = deferred.promise;
    exec(
      cmd,
      {cwd: cwd, timeout: 10000},
      function(err, stdout, stderr) {
        //console.log('Output for: ' + name)
        //console.log('stdout: ' + stdout);
        //console.log('stderr: ' + stderr);
        //console.log(err, "*** dep check done\n\n\n")
        if (err !== null) {
          if (cmd.indexOf('clone') !== -1) {
            console.log('Dependecy failed', err);
            deferred.reject();
          } else {
            console.log('Failed to pull dependency', err);
            deferred.resolve(name);
          }
        } else {
          console.log('Dependency resolved: ' + name);
          deferred.resolve(name);
        }
      }
    );
    return deferred.promise;
  } else {
    return alreadyUpdated[name];
  }
};

/**
 * Clone or git pull all dependencies in diversity.json into test/deps/
 * @param {string} name
 * @return {Promise} resolves to an object of diversity.json files.
 */
var updateDeps = function(name) {
  if (!exists(DEPS_FOLDER)) {
    realFs.mkdirSync(DEPS_FOLDER);
  }

  // Handle non component deps
  if (name.name && name.url) {
    return updateDependency(
      name.name,
      name.url
    );
  }

  var promises = [];

  var components = {};
  var loadAndUpdate = function(name) {

    var pth = path.join(
      process.cwd(),
      DEPS_FOLDER,
      name,
      'diversity.json'
    );

    return fs.read(pth).then(parseJSON).then(function(diversity) {
      var promises = [];
      components[diversity.name] = diversity;

      if (!diversity.dependencies || Object.keys(diversity.dependencies).length === 0) {
        //Return a promise that just resolves if there are no dependencies.
        return Q(true);
      }

      Object.keys(diversity.dependencies).forEach(function(name) {
        //After a component has been loaded we load all of it's dependencies
        //as well. This will probably issue a couple of "git pull" too much
        //but that's fast so it's ok. Again this is for development.

        promises.push(updateDependency(name).then(loadAndUpdate).then(function(res) {
          return res;
        }));
      });

      return Q.all(promises);
    });
  };

  // First load base component
  promises.push(updateDependency(name).then(loadAndUpdate));

  // Make sure to return the object with all diversity.json files
  return Q.all(promises).then(function() { return components; });
};

var parseJSON = function(data) {
  try {
    return JSON.parse(data);
  } catch (e) {
    return Q.reject('Error parsing JSON: ' + e.message + '\n\n'+data);
  }
};

module.exports = {
  DEPS_FOLDER: DEPS_FOLDER,
  parseJSON: parseJSON,
  updateDeps: updateDeps,
  updateDependency: updateDependency,
  reset: function() { alreadyUpdated = {}; }
};
