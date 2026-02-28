import $ from "jquery";

export function showErrorDialog(message) {
    const dialog = $(".dialogError")[0];
    if (!dialog) {
        console.error("Error dialog element not found");
        return;
    }

    $(".dialogError-content").html(message);

    $(".dialogError-closebtn")
        .off("click")
        .click(function () {
            dialog.close();
        });

    try {
        if (dialog.open) {
            dialog.close();
        }
        dialog.showModal();
    } catch (e) {
        console.error("Failed to show Error dialog:", e);
        dialog.setAttribute("open", "");
    }
}
