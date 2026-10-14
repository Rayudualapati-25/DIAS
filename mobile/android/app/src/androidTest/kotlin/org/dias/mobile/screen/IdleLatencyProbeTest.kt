package org.dias.mobile.screen

import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.dias.mobile.data.ApiClient
import org.dias.mobile.data.HostAddress
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URI

/**
 * A diagnostic, not a check of the app: how long the app's own HTTP client takes for a call to the host
 * after the phone has made no call for a while.
 */
@RunWith(AndroidJUnit4::class)
class IdleLatencyProbeTest {
    @Test fun aCallAfterAnIdleGapAgainstACallRightAfterIt() {
        val arguments = InstrumentationRegistry.getArguments()
        val apiBase = arguments.getString("apiBase")
        assumeTrue("Set apiBase and idleProbe=true to run the probe",
            apiBase != null && arguments.getString("idleProbe") == "true")
        val client = ApiClient(HostAddress.normalize(apiBase!!, true))
        fun timedCall(): Double {
            val started = SystemClock.elapsedRealtimeNanos()
            client.health()
            return (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0
        }
        timedCall() // The very first call of the process is not part of any gap
        val results = JSONArray()
        for (gapSeconds in GAPS_SECONDS) {
            Thread.sleep(gapSeconds * 1000L)
            results.put(JSONObject().put("idleSeconds", gapSeconds)
                .put("firstCallMs", timedCall()).put("nextCallMs", timedCall()))
        }
        // The same route with a fresh connection for every call.
        fun timedFreshCall(): Double {
            val started = SystemClock.elapsedRealtimeNanos()
            val connection = URI(client.baseUrl + "/api/health").toURL().openConnection() as HttpURLConnection
            try {
                connection.connectTimeout = 10_000
                connection.readTimeout = 30_000
                connection.setRequestProperty("Connection", "close")
                check(connection.responseCode == 200) { "health route answered ${connection.responseCode}" }
                connection.inputStream.use { it.readBytes() }
            } finally { connection.disconnect() }
            return (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0
        }
        timedFreshCall()
        val fresh = JSONArray()
        for (gapSeconds in FRESH_GAPS_SECONDS) {
            Thread.sleep(gapSeconds * 1000L)
            fresh.put(JSONObject().put("idleSeconds", gapSeconds)
                .put("firstCallMs", timedFreshCall()).put("nextCallMs", timedFreshCall()))
        }
        val folder = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "evidence")
            .apply { mkdirs() }
        File(folder, "idle-probe.json").writeText(JSONObject().put("route", "/api/health")
            .put("gaps", results).put("freshConnectionGaps", fresh).toString())
    }

    private companion object {
        val GAPS_SECONDS = listOf(0, 2, 5, 10, 15, 20, 30, 45, 60, 2, 30)
        val FRESH_GAPS_SECONDS = listOf(2, 15, 30)
    }
}
