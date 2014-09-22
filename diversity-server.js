/* global process */
var Q          = require('q');
var realFs     = require('fs');
var fs         = require('q-io/fs');
var http       = require("q-io/http");
var exec       = require('child_process').exec;
var path       = require('path');
var Mustache   = require('mustache');
var bodyParser = require('body-parser');
var express    = require('express');
var tinylr     = require('tiny-lr');
var app        = express();


// Start a tiny-lr server as well.
tinylr().listen(35729, function() {
  console.log('... Listening on 35729 ...');
});

// All components that are possible to actually place inside the theme.
var COMPONENTS = ['tws-custom-html', 'tws-cart', 'tws-top-menu' ,'tws-article-search', 'tws-article', 'tws-articlegroup-menu'];

if (process.argv.length < 4) {
  console.log('Usage:\n     node diversity-server.js <theme-component> <settings.json>');
  process.exit();
}

var DEPS_FOLDER = 'deps/';

app.use(bodyParser.json());
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
var alreadyUpdated = {};
var updateDependency = function(name, value) {
  var deferred = Q.defer();

  if (!alreadyUpdated[name]) {
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
    alreadyUpdated[name] = true;
    exec(
      cmd,
      {cwd: cwd},
      function (err) {
        if (err !== null) {
          delete alreadyUpdated[name];
          deferred.reject();
        } else {
          deferred.resolve(name);
        }
      }
    );
   } else {
    deferred.resolve(name);
   }
  return deferred.promise;
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
  promises.push(updateDependency(name).then(loadAndUpdate));

  // Make sure to return the object with all diversity.json files
  return Q.all(promises).then(function() { return components; });
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

var findComponentsInSettings = function(settings, fn) {
  if (!settings) {
    return;
  }
  var traverse = function(obj) {
    if (Array.isArray(obj)) {
      obj.forEach(traverse);
      return;
    }

    // Lets traverse all properties as well
    if (Object.isObject(obj)) {
      Object.keys(obj).forEach(function(key) {
        traverse(obj[key]);
      });
    }

    // An object is a component data settings if it has the attribute component  and its a string
    if (obj && obj.component && typeof obj.component === 'string') {
      fn(obj);
    }
  };
  traverse(settings);
};


/**
 * Traverses the dependeny tree of components depth first and
 * applies a function to all steps.
 * @param {Array} names a list of component names that are roots
 * @param {Object} defs object with all diversity.json definitions
 * @param {Function} fn a function to apply
 */
var traverseDeps = function(names, defs, fn) {
  names.forEach(function(name) {
    // Let's traverse and apply the apply function on each comp.
    // Depth first.
    var traverse = function(comp) {
      if (comp.done) {
        return;
      }

      fn(comp);
      comp.done = true;
      if (comp.dependencies) {
        Object.keys(comp.dependencies).forEach(function(n) {
          if (defs[n]) {
            traverse(defs[n]);
          }
        });
      }
    };
    traverse(defs[name]);
  });
};

var serveFile = function(filename, res) {
  // Mock settings from file
  fs.read(filename).then(parseJSON)
    .then(res.send.bind(res))
    .fail(function(err) {
      if (!Array.isArray(err)) {
        err = [err];
      }
      err.map(function(e) { return e.stack || e; });
      res.status(500).send('An error occured: ' + err.join('<br>'));
      console.log(err.stack);
    });
};

app.get('/diversity.json', function(req, res) {
  serveFile(path.join(
    process.cwd(),
    DEPS_FOLDER,
    process.argv[2],
    'diversity.json'
  ), res);
});

// Mock list components api
app.get('/components', function (req, res) {
  Q.all(
    COMPONENTS.map(function(c) {
      return http.read(
        'http://git.diversity.io/textalk-webshop-native-components/' + c +
        '/raw/master/diversity.json'
      ).then(parseJSON);
    })
  ).then(function(comps) {
    res.send(comps);
  }).fail(function(err) {
    if (!Array.isArray(err)) {
      err = [err];
    }
    err.map(function(e) { return e.stack || e; });
    res.status(500).send('An error occured: ' + err.join('<br>'));
    console.log(err.stack);
  });
});

app.get('/settings', function(req, res) {
  serveFile(process.argv[3], res);
});

app.post('/settings', function(req, res) {
  console.log('Saving settings');
  fs.write(process.argv[3], JSON.stringify(req.body, undefined, 2))
    .then(function() {
      res.send({});
      console.log('Settings changed, reloading');
      tinylr.changed('/');
    }).fail(function(err) {
      if (!Array.isArray(err)) {
        err = [err];
      }
      err.map(function(e) { return e.stack || e; });
      res.status(500).send('An error occured: ' + err.join('<br>'));
      console.log(err.stack);
    });
});

// We need tws-compontselector and jsquery.jsonrpcclient
updateDeps('tws-admin-schema-form').fail(function(err) {
  console.log(err);
});
updateDeps({
  name: 'jquery.jsonrpcclient.js',
  url: 'https://github.com/Textalk/jquery.jsonrpcclient.js.git'
});

app.get('/', function(req, res) {

  // Reset skip list
  alreadyUpdated = {};

  // We update dependencies and load diversity.json each time so we always pick up changes.
  // This is for development people!
  var name = process.argv[2];

  // Read settings from file, they can have updated.
  fs.read(process.argv[3]).then(parseJSON).then(function(settings) {
    console.log(settings);
    // We want to load the supplied theme + any components in it's settins
    var promises = [];

    promises.push(updateDeps(name));

    var settingsComponents = {};
    findComponentsInSettings(settings, function(c) {
      settingsComponents[c.component] = true;
    });

    Object.keys(settingsComponents).forEach(function(n) {
      promises.push(updateDeps(n));
    });

    return Q.all(promises).then(function(result) {
      var defs = result.reduce(function(soFar, obj) {
        Object.keys(obj).forEach(function(k) {
          if (obj[k] !== undefined) {
            soFar[k] = obj[k];
          }
        });
        return soFar;
      }, {});

      var createContext = function() {
        return {
          scripts: ['http://localhost:35729/livereload.js'],
          styles: [],
          modules: [],
          context: {
            'webshop_uid':  11011,
            'backend_url': 'davidstage.textalk.se/backend/jsonrpc/v1/',
            'webshop_url': 'http://shop.humle.se',
          }
        };
      };

      var prefix = function(name, url) {
        if (url.indexOf('//') === 0 ||
            url.indexOf('http://') === 0 ||
            url.indexOf('https://') === 0) {
          return url;
        }

        return path.join(DEPS_FOLDER, name, url);
      };

      var renderList = [];
      var templates = [];

      findComponentsInSettings(settings, function(obj) {
        // findComponentsInSettings goes depth first and applies children before parents
        var def = defs[obj.component];
        if (def.template) {
          // FIXME: alternative templates
          templates.push(fs.read(path.join(
            process.cwd(),
            DEPS_FOLDER,
            def.name,
            def.template
          )));
          renderList.push(obj);
        }
      });

      console.log('And the renderlist is!',renderList)

      // Load all templates
      return Q.all(templates).then(function(templateData) {

        // Render mustache templates for each in the list.
        renderList.forEach(function(obj, i) {

          var c = createContext();
          c.settings = obj.settings;
          c.settingsJSON = JSON.stringify(obj.settings).replace(/<\/script>/g,'<\\/script>')
          console.log('Rendering html for component ', obj.component);
          obj.componentHTML = renderMustache(templateData[i], c);
          console.log(obj.componentHTML);
        });

        var context = createContext();
        var names = Object.keys(settingsComponents);
        names.unshift(name);

        traverseDeps(names, defs, function(comp) {
          if (typeof comp.style === 'string') {
            context.styles.push(prefix(comp.name, comp.style));
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
            context.modules[comp.angular] = true;
          }
        });

        context.settings = settings;
        context.settingsJSON = JSON.stringify(settings).replace(/<\/script>/g,'<\\/script>');

        context.angularBootstrap = 'angular.module("tws",["' +
                                    Object.keys(context.modules).join('","') +
                                   '"])\n' + 'angular.bootstrap(document,["tws"])';


        // Lets render main mustache template;
        return fs.read(path.join(
          process.cwd(),
          DEPS_FOLDER,
          name,
          defs[name].template
        )).then(function(template) {
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
