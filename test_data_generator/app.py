"""Launch the independent Tkinter test-data interface."""
from pathlib import Path
import sys
import queue
import threading
import tkinter as tk
from tkinter import messagebox, ttk

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_data_generator.generator import DATABASE_PATH, Generator


class Application:
    def __init__(self, root):
        self.root = root
        self.events = queue.Queue()
        self.busy = False
        root.title("Karbon · Test Data Generator")
        root.minsize(650, 480)
        frame = ttk.Frame(root, padding=24)
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text="Test Data Generator", font=("TkDefaultFont", 20, "bold")).pack(anchor="w")
        ttk.Label(frame, text="Independent workspace tool · writes to Karbon’s existing database").pack(anchor="w", pady=(6, 14))
        ttk.Label(frame, text=f"Database: {DATABASE_PATH}", wraplength=600).pack(anchor="w")
        ttk.Label(frame, text="Quantity is the number of customers; each includes an invoice, items, expenses,\na purchase document, and a production task. Generated records appear in the dashboard.",
                  wraplength=600).pack(anchor="w", pady=12)
        controls = ttk.Frame(frame)
        controls.pack(fill="x", pady=8)
        ttk.Label(controls, text="Customers:").pack(side="left")
        self.quantity = tk.StringVar(value="1000")
        self.entry = ttk.Spinbox(controls, from_=1, to=100000, textvariable=self.quantity, width=10)
        self.entry.pack(side="left", padx=10)
        self.generate_button = ttk.Button(controls, text="Generate fake data", command=lambda: self.start("generate"))
        self.generate_button.pack(side="left", padx=6)
        self.delete_button = ttk.Button(controls, text="Delete all data", command=lambda: self.start("delete"))
        self.delete_button.pack(side="left", padx=6)
        ttk.Label(frame, text="Delete all data permanently removes ALL business records, including real data.\nOnly login accounts and the built-in bank catalog are kept.",
                  wraplength=600, foreground="#b42318").pack(anchor="w", pady=(8, 0))
        self.progress = ttk.Progressbar(frame, maximum=100)
        self.progress.pack(fill="x", pady=(16, 6))
        self.status = tk.StringVar(value="Ready")
        ttk.Label(frame, textvariable=self.status, wraplength=600).pack(anchor="w")
        self.output = tk.Text(frame, height=12, state="disabled", wrap="word")
        self.output.pack(fill="both", expand=True, pady=(12, 0))
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.after(100, self.poll)

    def start(self, operation):
        if self.busy:
            return
        count = 0
        if operation == "generate":
            try:
                count = int(self.quantity.get())
                if not 1 <= count <= 100000:
                    raise ValueError()
            except ValueError:
                messagebox.showerror("Invalid quantity", "Enter 1 to 100,000 customers.", parent=self.root)
                return
        self.busy = True
        for widget in (self.entry, self.generate_button, self.delete_button):
            widget.configure(state="disabled")
        self.progress["value"] = 0
        self.status.set("Waiting for database write lock…")
        def worker():
            try:
                generator = Generator()
                report = lambda value, message: self.events.put(("progress", (value, message)))
                result = generator.generate(count, report) if operation == "generate" else generator.delete(report)
                self.events.put(("success", (operation, result)))
            except Exception as error:
                self.events.put(("error", str(error)))
        threading.Thread(target=worker, daemon=False).start()

    def poll(self):
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "progress":
                    self.progress["value"], message = payload
                    self.status.set(message)
                    continue
                self.busy = False
                for widget in (self.entry, self.generate_button, self.delete_button):
                    widget.configure(state="normal")
                if kind == "error":
                    self.progress["value"] = 0
                    self.status.set("Operation rolled back")
                    self.write(f"Error: {payload}\n")
                    messagebox.showerror("Operation rolled back", payload, parent=self.root)
                else:
                    operation, result = payload
                    if operation == "generate":
                        message = (f"Generated {result['counts']['customers']:,} customers and related data "
                                   f"({result['total']:,} total records)")
                    else:
                        message = f"Deleted {result['total']:,} records. Dashboard is empty"
                    self.status.set(message)
                    self.write(message + "\n" + "\n".join(f"  {name}: {count:,}" for name, count in result["counts"].items()) + "\n\n")
                    messagebox.showinfo("Complete", message + ". Refresh the Karbon dashboard.", parent=self.root)
        except queue.Empty:
            pass
        self.root.after(100, self.poll)

    def write(self, message):
        self.output.configure(state="normal")
        self.output.insert("end", message)
        self.output.see("end")
        self.output.configure(state="disabled")

    def close(self):
        if self.busy:
            messagebox.showinfo("Operation in progress", "Wait for the transaction to finish before closing.", parent=self.root)
        else:
            self.root.destroy()


def main():
    root = tk.Tk()
    Application(root)
    root.mainloop()


if __name__ == "__main__":
    main()
