/* global exports */
var path       = require('path');
var Mustache   = require('mustache');

exports.createContext = function(webshopUid, webshopUrl, apiUrl, swsUrl, diversityUrl, spec) {
  return {
    scripts: [],
    styles: [],
    modules: [],
    context: {
      'webshopUid':  webshopUid,
      'apiUrl': apiUrl,
      'webshopUrl': webshopUrl,
      'serveWithStyleUrl': swsUrl,
      'baseUrl': path.join(diversityUrl, 'components', spec.name, spec.version, 'files') + '/'
    }
  };
};

exports.prefixFactory = function(server) {
  return function(name, version, url) {
    if (url.indexOf('//') === 0 ||
        url.indexOf('http://') === 0 ||
        url.indexOf('https://') === 0) {
      return url;
    }

    return server + path.join('components', name, version, 'files', url);
  };
};

exports.renderMustache = function(template, context, language) {
  language = language || 'en';
  context = context || {};
  //Add the lambdas we need
  context.lang = function() {
    return function(txt, render) {
      return render('{{=[[ ]]=}}' + txt.replace(/lang/g, language));
    };
  };
  context.currency = function() {
    return function(txt, render) {
      console.log('ERROR: currency lambda not implemented');
      return render(txt);
    };
  };
  context.gettext = function() {
    return function(txt, render) {
      console.log('ERROR: gettext lambda not implemented');
      return render('{{=[[ ]]=}}' + txt);
    };
  };

  return Mustache.render(template, context);
};
