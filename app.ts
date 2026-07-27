import app from "ags/gtk4/app"
import Adw from "gi://Adw"
import style from "./style.scss"
import NotificationPopups from "./notifications/NotificationPopups"

app.start({
	css: style,
	main() {
		// libadwaita only manages light/dark while it owns the GTK theme. Naming
		// adw-gtk3-dark here marked the theme as "custom", so libadwaita stepped
		// aside — and since adw-gtk3 ships no gtk-4.0 assets, GTK4 fell back to
		// the light Adwaita stylesheet and the popups rendered white.
		Adw.StyleManager.get_default().colorScheme = Adw.ColorScheme.FORCE_DARK
		NotificationPopups()
	},
	requestHandler(request: string, res: (response: any) => void) {
		// Handle requests
		console.log("Request received:", request)
		res("ok")
	},
})
