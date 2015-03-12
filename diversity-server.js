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

var sass = require('node-sass');

// Start a tiny-lr server as well.
//tinylr().listen(35729, function() {
//  console.log('... Listening on 35729 ...');
//});

if (process.argv.length < 4) {
  console.log('Usage:\n     node diversity-server.js <webshop-id> <theme-id|theme-name> [<auth>]');
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


app.use(function (req, res, next) {

  // Skip /deps, those are files
  if (req.url.indexOf('/deps') === 0 ||
      req.url.indexOf('/favicon.ico') === 0) {
    return next();
  }

  // Calculate settings and fetch the theme component
  var fetchThemeCompAndJson = function(name) {
    return deps.updateDeps({ // Since its not under webshop components we must give an url.
      name: name,
      url: 'http://git.diversity.io/themes/' + name + '.git'
      // The second updateDeps actually loads diversity.json
    }).then(deps.updateDeps);
  };

  var tid = parseInt(themeUid, 10);
  if (isNaN(tid)) {
    req.themeName = themeUid;
    // Its not a number but a theme name!
    // settings is just default from theme component.
    fetchThemeCompAndJson(req.themeName).then(function(comps) {
                   req.componentDefs = comps;
                   req.themeDiversityJson = comps[req.themeName];
                   var data = util.schemaDefaults(req.themeDiversityJson.settings);
                   return {params: {settings: data}};
                 }).then(function(theme) {
                   theme.params = theme.params || {component: 'aficionado'};
                   req.theme = theme;
                   next();
                 }, function(err) {  console.log('oh noes error!', err); });
  } else {
    api('Theme.get', [tid, true]).then(function(settings) {
      settings.params = settings.params || {component: 'aficionado'};

      // So we got settings, we still need to merge with defaults from schema.
      req.themeName = settings.params.component;
      return fetchThemeCompAndJson(req.themeName).then(function(comps) {
        req.componentDefs = comps;
        req.themeDiversityJson = req.componentDefs[req.themeName];
        return {
          params: {
            settings: settings.params.settings//util.schemaDefaults(req.themeDiversityJson.settings, settings.params.settings || {}),
          }
        };
      });
    }).then(function(theme) {
      theme.params = theme.params || {component: 'aficionado'};
      req.theme = theme;
      next();
    }, function(err) { console.log('oh man!', err);});
  }
});

app.get('/favicon.ico', function(req, res){
  res.status(404).send('');
});



Q.all([
  //deps.updateDeps('tws-admin-schema-form').fail(function(err) {
  //  console.log(err);
  //}),

  //deps.updateDeps({
  //  name: 'jquery.jsonrpcclient.js',
  //  url: 'https://github.com/Textalk/jquery.jsonrpcclient.js.git'
  //}),


  //deps.updateDeps({
  //  name: 'aficionado',
  //  url: 'http://git.diversity.io/themes/aficionado.git'
  //}),

  api('Webshop.get', [webshopUid, {url:'sv'}]).then(function(result) {
    webshopUrl = result.url.sv;
  })
]).then(function(res) {

  console.log(res)

  // app.get('/reset', function(req, res) {
  //   // Reset skip list
  //   deps.reset();
  //   deps.updateDeps({ //update aficionado
  //     name: 'aficionado',
  //     url: 'http://git.diversity.io/themes/aficionado.git'
  //   }).then(function(){
  //     res.send('OK');
  //   }, function() {
  //     res.send(500);
  //   })
  //
  // });


  // Sass it up!
  app.get('/css/components/:component/:version/css', function(req, res) {
    console.log('********', req.params);

    var data = Object.keys(req.query).map(function(k) {
      // FIXME: Use regexp to validate query paramaters.
      return '$' + k + ': ' + req.query[k] + ';';
    });

    var styles = typeof req.themeDiversityJson.style === 'string' ? [req.themeDiversityJson.style] : req.themeDiversityJson.style;

    // Filter out all scss files
    var re = /.+\.scss/;
    styles.filter(function(s) { return re.test(s); }).forEach(function(s) {
      data.push('@import \'' + s + '\';');
    });

    var stats = {};
    sass.render({
      data: data.join('\n'),
      includePaths: ['./deps/' + req.themeName],
      success: function(result) {
        res.set('Content-Type', 'text/css');
        res.set('Cache-Control', 'public, max-age=300');
        res.send(result.css);
      },
      error: function(err) {
        console.log(new Date(), err);
        res.status(500).send(err);
      },
      outputStyle: 'nested',
      stats: stats
    });
  });

  app.get('/*', function(req, res, next) {

    // Skip /deps, those are files
    if (req.url.indexOf('/deps') === 0) {
      return next();
    }
    // We update dependencies and load theme each time so we always pick up changes.
    // This is for development people!
    console.log(req.url, req.theme)
    var settings  = req.theme.params.settings;

    var defs = req.componentDefs;

    // We want to load the supplied themes components
    var promises = [];

    // We still might have tws-columns,tws-container etc in place of a component.
    // therefore we can't just a shallowly check settings.component.
    var names = [req.themeName];
    util.findComponentsInSettings(settings, function(c) {
      promises.push(deps.updateDeps(c.component));
      names.push(c.component);
    });

    return Q.all(promises).then(function(result) {
      // Collect allreq. diversity.json definitions
      result.reduce(function(soFar, obj) {
        Object.keys(obj).forEach(function(k) {
          if (obj[k] !== undefined) {
            soFar[k] = obj[k];
          }
        });
        return soFar;
      }, defs);

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
          c.settingsJSON = JSON.stringify(c.settings).replace(/<\/script>/g, '<\\/script>');
          obj.componentHTML = render.renderMustache(templateData[i], c);
        });

        var context = render.createContext(webshopUid, webshopUrl);
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

        // Filter out scss files.
        var re = /.*\.scss$/;
        context.styles = context.styles.filter(function(s) { return !re.test(s); });


        context.settings = settings;

        // Since settingsJSON is going up to the server we need to clean out redundant code.
        util.findComponentsInSettings(settings, function(obj) {
          delete obj.settings;
        }, true);
        context.settingsJSON = JSON.stringify(settings).replace(/<\/script>/g, '<\\/script>');

        context.angularBootstrap = 'angular.module("tws",["' +
                                    Object.keys(context.modules).join('","') +
                                   '"])\n' + 'angular.bootstrap(document,["tws"])';
        context.baseUrl = '/deps/' + req.themeName + '/';

        // Lets render main mustache template;
        return fs.read(path.join(
          process.cwd(),
          deps.DEPS_FOLDER,
          req.themeName,
          defs[req.themeName].template
        )).then(function(template) {
          res.send(render.renderMustache(template, context));
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

  console.log('Starting server')
  var server = app.listen(process.env.PORT || 3000, function() {
    console.log('Listening on port %d', server.address().port);
  });

});
