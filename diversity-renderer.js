/* global Mustache  */
(function($) {
  'use strict';

  var idCount = 0;

  var join = function(base, url) {
    if (url.indexOf('http') === 0 || url.indexOf('//') === 0) {
      return url;
    }
    return base + url;
  };

  var renderMustache = function(template, context) {
    context = context || {};

    //Add the lambdas we need
    context.lang = function() {
      return function(txt, render) {
        return render('{{=[[ ]]=}}' + txt.replace(/lang/g, 'sv'));
      };
    };
    context.currency =  function() {
      return function(txt, render) {
        return render('{{=[[ ]]=}}' + txt.replace(/currency/g, 'SEK'));
      };
    };
    context.gettext =  function() {
      return function(txt, render) {
        return render('{{=[[ ]]=}}' + txt);
      };
    };

    return Mustache.render(template, context);
  };

  var loadConfig = function(urls, configs, options, done) {
    var path = urls.shift();

    $.getJSON(path, function(config) {
      configs[config.name] = config;

      angular.forEach(config.dependencies, function(version, name) {
        if (!configs[name]) {
          urls.push(options.root + name + '/diversity.json');
        }
      });

      //Recurse and load the next
      if (urls.length > 0) {
        loadConfig(urls, configs, options, done);
      } else {
        //we're done!
        done();
      }
    });
  };

  //Load lots of json files recursively
  var loadAll = function(firstUrl, next, done) {
    if (angular.isString(firstUrl)) {
      firstUrl = [firstUrl];
    }

    var results = [];
    var loadAllInner = function(urls, next, done) {
      var path = urls.shift();
      console.log('ajax', path);
      $.ajax(path, {
        type: 'GET',
        dataType: 'text',
        success: function(data) {
          results.push(data);

          var n = next(path, data);
          if (angular.isString(n)) {
            urls.push(n);
          } else if (angular.isArray(n)) {
            urls = urls.concat(n);
          }
        },
        error: function() { console.log('fail', arguments); },
        complete: function() {
          if (urls.length > 0) {
            loadAllInner(urls, next, done);
          } else {
            done(results);
          }
        }
      });
    };

    loadAllInner(firstUrl, next, done);
  };

/*

        //We append scripts in the correct order
        //FIXME: probably not the best way to do it.
        frag = document.createDocumentFragment();
        angular.forEach(scripts,function(url){
          var script = document.createElement('script');
          script.setAttribute('type','text/javascript');
          script.innerHTML = cache[url];
          frag.appendChild(script);
          console.log(url);
        });

*/
  //We need to load scripts in the correct order, therefore we do it synced
  //probably doesn't work in ie.
  var loadScripts = function(scripts, allDone) {
    if (!scripts || scripts.length === 0) {
      allDone();
      return;
    }

    var url = scripts.shift();
    var script = document.createElement('script');
    script.setAttribute('type', 'text/javascript');
    script.onload = function() {
      //script onload!
      console.log('onload', url);
      loadScripts(scripts, allDone);
    };
    script.onerror = function() {
      console.log('onerror', url);
      loadScripts(scripts, allDone);
    };
    script.src = url;
    document.head.appendChild(script);
  };

  $.fn.diversity = function(name, options) {
    options = $.extend({
      root: '',  //root of main component
      deps: 'deps/', //root of component dependencies
      locale: 'sv',
      backend: 'https://davidstage.textalk.se/backend/jsonrpc/v1/',
      context:  {
        webshop: 11011,
        languageCode: 'sv',
        currencyCode: 'SEK'
      },
      module: null
    }, options);
    var target = this[0];

    //we need an id on target
    if (!target.id) {
      target.id = 'diversity-component-' + name + '-' + idCount++;
    }

    //Prepare global object for preloaded data, mostly translations
    window.tws = window.tws || {};
    window.tws.data = window.tws.data || {};

    //Start by loading all resources except scripts and CSS and cache them
    //This means all dependant components, all tranlations and all mustache
    //templates
    var cache = {};
    var configs = {};
    loadAll(
      options.root + '/diversity.json',
      function(path, data) {
        cache[path] = data;
        if (/diversity.json$/.test(path)) {
          if (angular.isString(data)) {
            data = JSON.parse(data);
          }
          var config = data;
          var basePath = path.substring(0, path.length - 14);
          config.basePath = basePath;
          configs[config.name] = config;

          var urls = [];
          angular.forEach(config.dependencies, function(version, name) {
            urls.push(options.deps + name + '/diversity.json');
          });

          if (angular.isString(config.template)) {
            urls.push(basePath + config.template);
          } else {
            angular.forEach(config.template, function(template) {
              urls.push(basePath + template);
            });
          }

          if (config.i18n && config.i18n[options.locale] &&
              config.i18n[options.locale].view) {
            urls.push(basePath + config.i18n[options.locale].view);
          }

          //filter out already loaded urls
          urls = urls.filter(function(url) { return !cache[url]; });

          return urls;
        }
      },
      function() {
        // Everything is loaded now. OK. lets traverse the dependency tree and
        // load scripts and css, and why not parse some mustach?
        var config  = configs[name];
        var scripts = [];
        var styles  = [];
        var done    = {};

        // Sanity check.
        if (!config) {
          throw Error('No component by name: ' + name);
        }

        var bottomsup = function(component) {
          //bail out if this component is already loaded
          //i.e. several components depend on the same base component (tws-api)
          if (done[component.name]) {
            return;
          }

          //Do any dependencies first.
          angular.forEach(component.dependencies, function(version, name) {
            bottomsup(configs[name]);
          });

          //base url differs between
          options.context.baseUrl = component.basePath;
          //Add styles, we need this to get the order right
          if (angular.isString(component.script)) {
            scripts.push(join(component.basePath, component.script));
          } else {
            angular.forEach(component.script, function(url) {
              scripts.push(join(component.basePath, url));
            });
          }

          if (angular.isString(component.style)) {
            styles.push(join(component.basePath, component.style));
          } else {
            angular.forEach(component.style, function(url) {
              styles.push(join(component.basePath, url));
            });
          }

          //FIXME: support more than swedish
          if (component.i18n && component.i18n.sv && component.i18n.sv.view) {
            var po = cache[join(component.basePath, component.i18n.sv.view)];
            if (po) {
              //Might be initialized in template, might not.
              if (!window.tws.data[component.name]) {
                window.tws.data[component.name] = {};
              }
              window.tws.data[component.name].messages = JSON.parse(po);
              console.log(window.tws.data[component.name].messages);
            }
          }

          //mark as done!
          done[component.name] = true;
        };
        bottomsup(config);

        //now let's create some tags
        var frag = document.createDocumentFragment();

        angular.forEach(styles, function(style) {
          var link = document.createElement('link');
          link.setAttribute('rel', 'stylesheet');
          link.setAttribute('href', style);
          frag.appendChild(link);
        });

        //Then add them to head
        $('head')[0].appendChild(frag);

        console.log('Loading scripts');
        loadScripts(scripts, function() {
          // All scripts have loaded, let's render and boostrap

          // We only render template for top component
          // TODO: make API requests
          // TODO: get params
          // TODO: pageTypes
          // TODO: template choice
          if (config.template) {
            var template = config.template;
            if (angular.isArray(config.template)) {
              template = config.template[0];
            }
            var html = renderMustache(
              cache[config.basePath + template],
              options.context
            );
            target.innerHTML = html;

            // Eval any script tags
            var scripts = target.querySelectorAll('script');
            for (var i = 0; i < scripts.length; i++) {
              var script = scripts[i];
              if (script.type === 'text/javascript' && script.src === '') {
                eval(script.innerHTML);
              }
            }

          }

          // We append bootstrap code as a script tag below the others, so it's executed whenever the
          // other scripts has loaded.
          // TODO support more than one component on a page
          if (config.angular) {
            var frag = document.createDocumentFragment();
            var bootstrap = document.createElement('script');
            bootstrap.setAttribute('type', 'text/javascript');

            /* jscs: disable */
            var setup = [
            "console.log('bootstrap')",
            "angular.module('diversity',['"+config.angular+"'])",
                  ".constant('shopId','"+options.context.webshop+"')",
                  ".constant('language','"+options.context.languageCode+"')",
                  ".config(['twsApi.JsonRpcClientProvider','twsApi.SessionProvider','twsApi.JedProvider','shopId','language',",
                  "function(twsJsonRpcClientProvider,  twsSessionProvider,  twsJedProvider,  shopId, language){",
                  " twsJsonRpcClientProvider.set(",
                  "     'ajaxUrl',               ",
                  "     '" + options.backend+"?webshop='+shopId+'&language='+language",
                  "   );",
                  " if (window.localStorage) {",
                  "     twsSessionProvider.setSessionId(localStorage.getItem('tws.sessionId'));",
                  " }",
                  " twsSessionProvider.setResetJsonRpcOnSession(true);",
                  "}]);",
                  'angular.bootstrap(document.body,["diversity"' +
                  (options.module ? ',"' + options.module +'"' :'') + ']);'
            ];
            /* jscs: enable */
            bootstrap.innerHTML = setup.join('\n');
            frag.appendChild(bootstrap);
            target.appendChild(frag);
          }
        });

      });
  };

})(jQuery);
