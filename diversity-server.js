/* global process */
var Q          = require('q');
var fs         = require('q-io/fs');

var path       = require('path');
var bodyParser = require('body-parser');
var express    = require('express');
var tinylr     = require('tiny-lr');
var app        = express();

var util       = require('./lib/util.js');
var apiFactory = require('./lib/api.js').factory;
var render     = require('./lib/render.js');
var deps       = require('./lib/deps.js');

// Start a tiny-lr server as well.
tinylr().listen(35729, function() {
  console.log('... Listening on 35729 ...');
});

if (process.argv.length < 4) {
  console.log('Usage:\n     node diversity-server.js <webshopid> <themeid|settings.json> [<auth>]');
  process.exit();
}

var webshopUid = process.argv[2];
var webshopUrl;
var themeUid = process.argv[3];
var auth = process.argv[4];

var api = apiFactory(webshopUid, 'sv', auth);


//ZGF2aWRAdGV4dGFsay5zZTsxNDEyMzIyNTIyO2EwOTJkOTJiNDlkNGYzN2I0ZmMxMjI2ZGI2NmU5MTg3

app.use(bodyParser.json());
app.use(express.static('.'));

Q.all([
  // We need tws-compontselector and jsquery.jsonrpcclient
  deps.updateDeps('tws-admin-schema-form').fail(function(err) {
    console.log(err);
  }),

  deps.updateDeps({
    name: 'jquery.jsonrpcclient.js',
    url: 'https://github.com/Textalk/jquery.jsonrpcclient.js.git'
  }),

  
  deps.updateDeps({
    name: 'aficionado',
    url: 'http://git.diversity.io/shop-themes/aficionado.git'
  }),

  api('Webshop.get', [webshopUid, {url:'sv'}]).then(function(result) {
    webshopUrl = result.url.sv;
  })
]).then(function() {

  app.get('/reset', function(req, res) {
    // Reset skip list
    deps.reset();
    deps.updateDeps({ //update aficionado
      name: 'aficionado',
      url: 'http://git.diversity.io/shop-themes/aficionado.git'
    }).then(function(){
      res.send('OK');
    }, function() {
      res.send(500);
    })
    
  });

  app.get('/*', function(req, res, next) {

    // Skip /deps, those are files
    if (req.url.indexOf('/deps') === 0) {
      return next();
    }

    var tid = parseInt(themeUid, 10);
    var settingsPromise;
    if (isNaN(tid)) {
      //Its not a number but a settings file!
      settingsPromise = fs.read(themeUid).then(deps.parseJSON).then(function(settings) {
        return {params: {settings:settings}};
      });
    } else {
      settingsPromise = api('Theme.get', [tid, true]);
    }

    // We update dependencies and load theme each time so we always pick up changes.
    // This is for development people!
    settingsPromise.then(function(theme) {
      var settings  = (theme.params && theme.params.settings) || {};
      var name      = (theme.params && theme.params.component) || 'tws-theme';

      // We want to load the supplied theme + any components in it's settins
      var promises = [];

      promises.push(deps.updateDeps(name));

      var settingsComponents = {};
      util.findComponentsInSettings(settings, function(c) {
        settingsComponents[c.component] = true;
      });

      Object.keys(settingsComponents).forEach(function(n) {
        promises.push(deps.updateDeps(n));
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

        var renderList = [];
        var templates = [];

        util.findComponentsInSettings(settings, function(obj) {
          // findComponentsInSettings goes depth first and applies children before parents
          var def = defs[obj.component];
          if (def.template) {
            // FIXME: alternative templates
            templates.push(fs.read(path.join(
              process.cwd(),
              deps.DEPS_FOLDER,
              def.name,
              def.template
            )));
            renderList.push(obj);
          }
        });
        //console.log('And the renderlist is: ', renderList.map(function(c) {
        //  return c.component;
        //}));

        // Load all templates
        return Q.all(templates).then(function(templateData) {

          // Render mustache templates for each in the list.
          renderList.forEach(function(obj, i) {

            var c = render.createContext(webshopUid, webshopUrl);
            c.settings = obj.settings || {};
            c.settingsJSON = JSON.stringify(obj.settings).replace(/<\/script>/g,'<\\/script>')
            obj.componentHTML = render.renderMustache(templateData[i], c);
          });

          var context = render.createContext(webshopUid, webshopUrl);
          var names = Object.keys(settingsComponents);
          names.unshift(name);

          var prefix = render.prefixFactory(deps.DEPS_FOLDER);

          util.traverseDeps(names, defs, function(comp) {
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

          // Since settingsJSON is going up to the server we need to clean out redundant code.
          util.findComponentsInSettings(settings, function(obj) {
            delete obj.settings;
          }, true);

          context.settingsJSON = JSON.stringify(settings).replace(/<\/script>/g,'<\\/script>');

          context.angularBootstrap = 'angular.module("tws",["' +
                                      Object.keys(context.modules).join('","') +
                                     '"])\n' + 'angular.bootstrap(document,["tws"])';

          // Lets render main mustache template;
          return fs.read(path.join(
            process.cwd(),
            deps.DEPS_FOLDER,
            name,
            defs[name].template
          )).then(function(template) {
            res.send(render.renderMustache(template, context));
          });

        });
      });
    }).fail(function(err) {
      if (!Array.isArray(err)) {
        err = [err];
      }
      console.log(err.join(err.join('\n')));
      err.map(function(e) { return e.stack || e; });
      res.status(500).send('An error occured: ' + err.join('<br>'));

    });
  });

  var server = app.listen(3000, function() {
    console.log('Listening on port %d', server.address().port);
  });

});
