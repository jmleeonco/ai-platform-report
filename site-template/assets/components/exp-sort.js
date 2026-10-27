/* exp-sort component for topic index pages.
 *
 * Orders the `.exp-row` items inside each `.exp-list` by their `.exp-num` ("실험 N")
 * in DESCENDING order — highest experiment number first, so the latest experiment leads.
 *
 * Runs purely from the DOM with no network access, so the ordering also applies when a
 * topic page is opened directly via file:// (not just over http). Sorting is stable:
 * rows whose `.exp-num` is missing or non-numeric keep their document order and sink last.
 *
 * It also keeps the "N experiments" count badge in sync with the actual number of
 * `.exp-row` items, so adding or removing an experiment never leaves a stale hand-written
 * count. It updates an EXISTING count badge only (the `.page-subtitle .badge` whose text
 * mentions "experiment") — it never creates one, and leaves other badges untouched.
 */
(function () {
  function expNum(row) {
    var el = row.querySelector(".exp-num");
    var d = el ? (el.textContent || "").replace(/\D/g, "") : "";
    return d ? parseInt(d, 10) : -1;
  }
  var lists = document.querySelectorAll(".exp-list");
  for (var i = 0; i < lists.length; i++) {
    var list = lists[i];
    Array.prototype.slice.call(list.querySelectorAll(":scope > .exp-row"))
      .map(function (row, j) { return { row: row, j: j, n: expNum(row) }; })
      .sort(function (a, b) { return b.n - a.n || a.j - b.j; })
      .forEach(function (o) { list.appendChild(o.row); });
  }

  // Sync the count badge to the real number of experiment rows.
  var n = document.querySelectorAll(".exp-list > .exp-row").length;
  var badges = document.querySelectorAll(".page-subtitle .badge");
  for (var b = 0; b < badges.length; b++) {
    if (/\bexperiments?\b/i.test(badges[b].textContent)) {
      badges[b].textContent = n + " experiment" + (n === 1 ? "" : "s");
      break;
    }
  }
})();
