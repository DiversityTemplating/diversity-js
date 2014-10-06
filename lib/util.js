/* global exports */
exports.findComponentsInSettings = function(settings, fn) {
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
exports.traverseDeps = function(names, defs, fn) {
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
