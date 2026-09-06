package in.gammaterminal.app;

import android.os.Bundle;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebSettings s = this.bridge.getWebView().getSettings();
        // ignore the device's system font-size / display-size setting — the
        // terminal defines its own type scale
        s.setTextZoom(100);
        // let the user pinch-zoom into dense panels
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
    }
}
