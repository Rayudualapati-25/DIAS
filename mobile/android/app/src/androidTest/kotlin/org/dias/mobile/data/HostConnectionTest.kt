package org.dias.mobile.data

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.dias.mobile.domain.CaseSummary
import org.dias.mobile.domain.Session
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URI

@RunWith(AndroidJUnit4::class)
class HostConnectionTest {
    @Test fun emulatorAliasToMacApiAndFabric() = connect("apiBase")
    @Test fun reverseForwardingToMacApiAndFabric() = connect("reverseBase")

    private fun connect(argument: String) {
        val arguments = InstrumentationRegistry.getArguments()
        val host = arguments.getString(argument)
        assumeTrue("Set $argument to exercise a live Mac host", host != null)
        val remote = ApiClient(HostAddress.normalize(host!!, true))
        remote.health()
        val session = remote.login(arguments.getString("username") ?: "insp.sharma")
        val portalBefore = portalCases(session)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "host-connection-test.db"
        context.deleteDatabase(name)
        val database = CaseDatabase(context, name)
        try {
            val repository = CaseRepository(database, remote)
            var pages = 0
            do {
                assertTrue(repository.fetchBatch(session) <= 20)
                pages++
                check(pages <= 100) { "Live fixture exceeded the test page cap" }
            } while (repository.state(session)?.complete != true)
            val count = repository.count(session)
            val saved = (0 until count step 20).flatMap { repository.cached(session, 20, it) }
            // Compare all summary fields, not merely reachability or row counts.
            assertEquals("Portal changed during the check; repeat against a stable snapshot",
                portalBefore, portalCases(session))
            assertEquals("SQLite must match the same portal's case summaries", portalBefore, saved)
            repository.fetchBatch(session, restart = true)
            assertEquals(saved.take(20), repository.cached(session, 20, 0))
            assertEquals(count.coerceAtMost(20), repository.count(session))
            val evidence = JSONObject().put("host", session.baseUrl).put("username", session.username)
                .put("pages", pages).put("cachedSummaries", count).put("exactPortalParity", true)
                .put("items", JSONArray(saved.map { item ->
                    JSONObject().put("caseId", item.caseId).put("owningAgency", item.owningAgency)
                        .put("jurisdiction", item.jurisdiction).put("status", item.status)
                }))
            context.cacheDir.resolve("dias-$argument-parity.json").writeText(evidence.toString(2))
            Log.i("DIAS-foundation", "$argument: pages=$pages cachedSummaries=$count")
            // Cached screen reads require neither a token request nor a network call.
            assertEquals(count.coerceAtMost(20), repository.cached(session, 20, 0).size)
        } finally {
            database.close(); context.deleteDatabase(name)
        }
    }

    /** Website baseline stays in the test layer; the app continues to use batches. */
    private fun portalCases(session: Session): List<CaseSummary> {
        val connection = URI(session.baseUrl + "/api/cases").toURL().openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 10_000
            connection.readTimeout = 30_000
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Authorization", "Bearer ${session.token}")
            assertEquals(200, connection.responseCode)
            val response = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
            assertTrue(response.getBoolean("success"))
            val items = response.getJSONArray("data")
            return (0 until items.length()).map { index ->
                val item = items.getJSONObject(index)
                CaseSummary(item.getString("caseId"), item.getString("owningAgency"),
                    item.getString("jurisdiction"), item.getString("status"))
            }.sortedBy { it.caseId }
        } finally { connection.disconnect() }
    }
}
