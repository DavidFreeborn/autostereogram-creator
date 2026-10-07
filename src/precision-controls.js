export function bindNumericRanges(ids, cancelEdit) {
  for (const id of ids) {
    const range = document.getElementById(id),
      output = document.getElementById(id + "-value");
    if (!range || !output) continue;
    const holder = document.createElement("span"),
      number = document.createElement("input"),
      unit = document.createElement("span");
    holder.className = "precision-value";
    number.type = "number";
    number.id = id + "-number";
    for (const key of ["min", "max", "step"])
      if (range.hasAttribute(key))
        number.setAttribute(key, range.getAttribute(key));
    number.setAttribute(
      "aria-label",
      (range.labels?.[0]?.textContent.split(/\d/)[0].trim() || id) + " value",
    );
    unit.textContent = id === "repeat" || id === "soften" ? "px" : "%";
    holder.append(number, unit);
    output.hidden = true;
    output.after(holder);
    function sync(force = false) {
      if (force || document.activeElement !== number)
        number.value = range.value;
      number.disabled = range.disabled;
    }
    new MutationObserver(() => sync()).observe(output, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    new MutationObserver(() => sync()).observe(range, {
      attributes: true,
      attributeFilter: ["disabled"],
    });
    let start = range.value;
    number.addEventListener("focus", () => {
      start = range.value;
      number.select();
    });
    number.addEventListener("input", () => {
      if (number.value !== "" && number.validity.valid) {
        range.value = number.value;
        range.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    number.addEventListener("change", () => {
      if (!number.validity.valid || number.value === "") sync(true);
      range.dispatchEvent(new Event("change", { bubbles: true }));
    });
    number.addEventListener("blur", () => {
      sync(true);
      range.dispatchEvent(new Event("change", { bubbles: true }));
    });
    number.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!cancelEdit()) {
          range.value = start;
          range.dispatchEvent(new Event("input", { bubbles: true }));
        }
        sync(true);
        number.blur();
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (number.reportValidity() && number.value !== "") {
          range.dispatchEvent(new Event("change", { bubbles: true }));
          number.blur();
        }
      }
    });
    range.addEventListener("input", () => sync(true));
    sync();
  }
}
