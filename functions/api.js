export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.DBO_APPS_SCRIPT_URL || !env.DBO_API_SECRET) {
    return json({ ok:false, error:"Cloudflare environment variables are not configured." }, 500);
  }

  try {
    const body = await request.json();
    const upstream = await fetch(env.DBO_APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        "Cache-Control": "no-store"
      },
      body: JSON.stringify({
        action: body.action || "",
        payload: body.payload || {},
        secret: env.DBO_API_SECRET
      }),
      redirect: "follow"
    });

    const text = await upstream.text();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      return json({ ok:false, error:"Google Apps Script returned an invalid response." }, 502);
    }

    return json(parsed, parsed.ok === false ? 400 : 200);
  } catch (err) {
    return json({ ok:false, error:String(err && err.message ? err.message : err) }, 500);
  }
}

export async function onRequestGet() {
  return json({ ok:true, service:"DBO Cloudflare API Proxy" });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Allow":"GET,POST,OPTIONS",
      "Cache-Control":"no-store"
    }
  });
}

function json(data, status=200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type":"application/json;charset=UTF-8",
      "Cache-Control":"no-store",
      "X-Content-Type-Options":"nosniff"
    }
  });
}
