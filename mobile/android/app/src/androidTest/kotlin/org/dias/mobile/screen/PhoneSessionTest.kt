package org.dias.mobile.screen

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.dias.mobile.data.HostAddress
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * A phone that takes part in an experiment against the real Mac host, as an officer, as an auditor, or as
 * both in turn.
 */
@RunWith(AndroidJUnit4::class)
class PhoneSessionTest {
    @Test fun aPersonServesTheExperimentFromThePhone() {
        val arguments = InstrumentationRegistry.getArguments()
        val apiBase = arguments.getString("apiBase")
        val session = arguments.getString("experimentSession")
        val username = arguments.getString("username")
        assumeTrue("Set apiBase, experimentSession and username to serve an experiment",
            apiBase != null && username != null && session != null && SESSION_NAME.matches(session))
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val folder = File(target.cacheDir, "evidence/session-$session").apply { mkdirs() }
        val screen = Screen()
        try {
            ExperimentSession(screen, folder, HostAddress.normalize(apiBase!!, true)).serve(username!!)
        } finally { screen.close() }
    }

    private companion object {
        val SESSION_NAME = Regex("^[A-Za-z0-9-]{1,40}$")
    }
}
