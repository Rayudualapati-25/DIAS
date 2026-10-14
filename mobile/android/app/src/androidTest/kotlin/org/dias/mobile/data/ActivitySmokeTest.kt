package org.dias.mobile.data

import android.content.Intent
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.dias.mobile.presentation.MainActivity
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ActivitySmokeTest {
    @Test fun connectSignInCacheAndSignOutThroughScreen() {
        val instrument = InstrumentationRegistry.getInstrumentation()
        val arguments = InstrumentationRegistry.getArguments()
        val address = arguments.getString("apiBase")
        assumeTrue("Set apiBase to test the screen with a live host", address != null)
        val activity = instrument.startActivitySync(Intent(instrument.targetContext, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        fun <T : View> field(tag: String): T = activity.window.decorView.findViewWithTag(tag)
        fun click(tag: String) = instrument.runOnMainSync { field<Button>(tag).performClick() }
        fun awaitMessage(expected: String) {
            val deadline = System.currentTimeMillis() + 15_000
            var value = ""
            do {
                instrument.runOnMainSync { value = field<TextView>("message").text.toString() }
                if (value.contains(expected)) return
                Thread.sleep(100)
            } while (System.currentTimeMillis() < deadline)
            fail("Expected '$expected', received '$value'")
        }
        try {
            instrument.runOnMainSync {
                field<EditText>("host").setText(address)
                field<EditText>("username").setText(arguments.getString("username") ?: "insp.sharma")
            }
            click("check"); awaitMessage("Host reachable")
            click("login"); awaitMessage("Signed in")
            click("refresh"); awaitMessage("summaries from the host")
            instrument.runOnMainSync { assertFalse(field<Button>("login").isEnabled) }
            click("logout"); awaitMessage("Saved summaries cleared")
            instrument.runOnMainSync {
                assertEquals(0, field<LinearLayout>("cases").childCount)
                assertTrue(field<EditText>("host").isEnabled)
            }
        } finally { instrument.runOnMainSync { activity.finish() } }
    }
}
