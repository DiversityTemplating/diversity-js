/* global process */
var Q        = require('q');
var realFs   = require('fs');
var fs       = require('q-io/fs');
var exec     = require('child_process').exec;
var path     = require('path');
var Mustache = require('mustache');
var express  = require('express');
var app      = express();

if (process.argv.length < 3) {
  console.log('Usage:\n     node diversity-server.js <theme-component>');
  process.exit();
}

var DEPS_FOLDER = 'deps/';

app.use(express.static('.'));

// FIXME: move to module
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
var updateDependency = function(name, value) {
  var deferred = Q.defer();

  console.log('Checking dependency ' + name);
  var pth = path.join(process.cwd(), DEPS_FOLDER + name);

  //Have we aldready cloned the repo?
  var cmd = 'git pull';
  var cwd = pth;
  if (!exists(pth)) {
    var url = 'http://git.diversity.io/textalk-webshop-native-components/' +
              name + '.git ';
    if (/^(https{0,1}:\/\/|\/\/|git).*/.test(value)) {
      url = value;
    }
    cmd = 'git clone ' + url;
    cwd = path.join(process.cwd(), DEPS_FOLDER);
  }
  console.log(cmd, cwd);
  exec(
    cmd,
    {cwd: cwd},
    function (err) {
      if (err !== null) {
        deferred.reject();
      } else {
        deferred.resolve(name);
      }
    }
  );
  return deferred.promise;
};

/**
 * Clone or git pull all dependencies in diversity.json into test/deps/
 */
var updateDeps = function(name) {
  if (!exists(DEPS_FOLDER)) {
    realFs.mkdirSync(DEPS_FOLDER);
  }

  var promises = [];

  //and jquery jsonrpc client
  promises.push(
    updateDependency(
      'jquery.jsonrpcclient.js',
      'https://github.com/Textalk/jquery.jsonrpcclient.js.git'
    )
  );

  var loadAndUpdate = function(name) {
    var pth = path.join(
      process.cwd(),
      DEPS_FOLDER,
      name,
      'diversity.json'
    );
    return fs.read(pth).then(parseJSON).then(function(diversity) {
      var promises = [];

      console.log('Load and update ', pth);
      if (!diversity.dependencies || Object.keys(diversity.dependencies).length === 0) {
        //Return a promise that just resolves if there are no dependencies.
        return Q(true);
      }

      Object.keys(diversity.dependencies).forEach(function(name) {
        //After a component has been loaded we load all of it's dependencies
        //as well. This will probably issue a couple of "git pull" too much
        //but that's fast so it's ok. Again this is for development.

        promises.push(updateDependency(name).then(loadAndUpdate));
      });

      return Q.all(promises);
    });
  };

  // First load base component
  updateDependency(name).then(loadAndUpdate);

  return Q.all(promises);
};


var renderMustache = function(template, context) {
  context = context || {};
  //Add the lambdas we need
  context.lang = function() {
    return function(txt, render) {
      return render('{{=[[ ]]=}}' + txt.replace(/lang/g, 'sv'));
    };
  };
  context.currency = function() {
    return function(txt, render) {
      return render('{{=[[ ]]=}}' + txt.replace(/currency/g, 'SEK'));
    };
  };
  context.gettext = function() {
    return function(txt, render) {
      return render('{{=[[ ]]=}}' + txt);
    };
  };
  return Mustache.render(template, context);
};

var parseJSON = function(data) {
  try {
    return JSON.parse(data);
  } catch (e) {
    return Q.reject('Error parsing JSON');
  }
};

var load = function(comp, comps) {
  var promises = [];
  if (comp.dependencies) {
    // We don't handle version numbers right now
    Object.keys(comp.dependencies).forEach(function(name) {
      if (!comps[name]) {
        console.log('Loading', name);
        var p = fs.read(DEPS_FOLDER + name + '/diversity.json')
                 .then(parseJSON)
                 .then(function(c) {
                   comps[name] = c;
                   return load(c, comps);
                 });
        promises.push(p);
      }
    });
  }
  return Q.all(promises);
};

var deps = function(comp, fn) {
  var comps = {};
  comps[comp.name] = comp;

  return load(comp, comps).then(function() {
    // Let's traverse and apply the apply function on each comp.
    // Depth first.
    var traverse = function(comp) {

      fn(comp);
      comp.done = true;
      if (comp.dependencies) {
        Object.keys(comp.dependencies).forEach(function(name) {
          var c = comps[name];
          if (c && !c.done) {
            traverse(c);
          }
        });
      }
    };
    traverse(comp);
  });
};

app.get('/', function(req, res) {

  // We update dependencies and load diversity.json each time so we always pick up changes.
  // This is for development people!
  var name = process.argv[2];
  updateDeps(name).then(function() {
    return Q.all([

      fs.read(path.join(
        process.cwd(),
        DEPS_FOLDER,
        name,
        'diversity.json'
      )).then(parseJSON),

      // Mock settings from file
      fs.read('settings.json').then(parseJSON)

    ]).then(function(result) {
      var def = result[0];
      //var settings = result[1];
      var prefix = function(name, url) {
        if (url.indexOf('//') === 0 ||
            url.indexOf('http://') === 0 ||
            url.indexOf('https://') === 0) {
          return url;
        }

        return path.join(DEPS_FOLDER, name, url);
      };

      return fs.read(
        path.join(
          process.cwd(),
          DEPS_FOLDER,
          def.name,
          def.template
        )
      ).then(function(template) {
        var context = {
          scripts: [],
          styles: [],
          modules: [],
          context: {
            'webshop_uid':  11011,
            'backend_url': 'davidstage.textalk.se/backend/jsonrpc/v1/',
            'webshop_url': 'http://shop.humle.se.davidstage.textalk.se',
          }
        };

        return deps(def, function(comp) {
          if (typeof comp.style === 'string') {
            context.styles.unshift(prefix(comp.name, comp.style));
          } else if (typeof comp.style !== 'undefined') {
            context.styles = comp.style.map(function(u) {
              return prefix(comp.name, u);
            }).concat(context.styles);
          }

          if (typeof comp.script === 'string') {
            context.scripts.unshift(prefix(comp.name, comp.script));
          } else if (typeof comp.script !== 'undefined') {
            context.scripts = comp.script.map(function(u) {
              return prefix(comp.name, u);
            }).concat(context.scripts);
          }

          if (comp.angular) {
            context.modules.push(comp.angular);
          }

        }).then(function() {
          context.angularBootstrap = 'angular.module("tws",["' + context.modules.join('","') +
                                      '"])\n' + 'angular.bootstrap(document,["tws"])';
          res.send(renderMustache(template, context));
        });
      });
    });
  }).fail(function(err) {
    if (!Array.isArray(err)) {
      err = [err];
    }
    err.map(function(e) { return e.stack || e; });
    res.status(500).send('An error occured: ' + err.join('<br>'));
    console.log(err.stack);
  });

});

var server = app.listen(3000, function() {
  console.log('Listening on port %d', server.address().port);
});
