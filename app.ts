import app from "ags/gtk4/app"
import style from "./style.scss"
import NotificationPopups from "./notifications/NotificationPopups"

app.start({
	css: style,
	gtkTheme: "adw-gtk3-dark",
	main() {
		NotificationPopups()
	},
	requestHandler(request: string, res: (response: any) => void) {
		// Handle requests
		console.log("Request received:", request)
		res("ok")
	},
})
