const params = new URLSearchParams(location.hash.slice(1));
const tenant = params.get("tenant"),
  recipient = params.get("recipient"),
  token = params.get("token");
const el = (id) => document.getElementById(id);
const path =
  "/api/v1/bid-response/" +
  encodeURIComponent(tenant ?? "") +
  "/" +
  encodeURIComponent(recipient ?? "");
async function api(options = {}) {
  const r = await fetch(path, {
    ...options,
    headers: { "X-Bid-Token": token ?? "", "Content-Type": "application/json" },
  });
  const b = await r.json();
  if (!r.ok) throw Error(b.error?.message || "Request unavailable");
  return b.data;
}
try {
  const b = await api();
  el("title").textContent = b.subject;
  el("scope").textContent = b.scope;
  el("dates").textContent =
    "Quote due: " +
    (b.due_on?.slice(0, 10) || "Please advise") +
    " · Work window: " +
    (b.window_start?.slice(0, 10) || "To be confirmed") +
    " to " +
    (b.window_end?.slice(0, 10) || "To be confirmed");
  el("amount-label").firstChild.textContent =
    "Quoted amount (" + b.currency + ")";
  el("status").value = ["interested", "quoted", "declined"].includes(
    b.response_status,
  )
    ? b.response_status
    : "interested";
  el("amount").value = b.quote_amount ?? "";
  el("available").value = b.available_from?.slice(0, 10) ?? "";
  el("notes").value = b.response_notes ?? "";
  el("message").textContent = ["awarded", "not_selected"].includes(
    b.response_status,
  )
    ? "This bid has been decided. Contact the project manager for details."
    : "";
  el("request").hidden = false;
  if (["awarded", "not_selected"].includes(b.response_status))
    el("response").hidden = true;
} catch (e) {
  el("message").textContent = e.message;
}
el("response").addEventListener("submit", async (e) => {
  e.preventDefault();
  el("save").disabled = true;
  try {
    await api({
      method: "POST",
      body: JSON.stringify({
        response_status: el("status").value,
        quote_amount:
          el("amount").value === "" ? null : Number(el("amount").value),
        available_from: el("available").value || null,
        response_notes: el("notes").value,
      }),
    });
    el("message").textContent = "Your response has been saved. Thank you.";
  } catch (error) {
    el("message").textContent = error.message;
  } finally {
    el("save").disabled = false;
  }
});
