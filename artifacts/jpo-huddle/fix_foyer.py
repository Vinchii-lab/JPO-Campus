import json

with open("/home/runner/workspace/artifacts/jpo-huddle/public/commercial-layouts.json", "r") as f:
    manifest = json.load(f)

# Re-build Museum Foyer
foyer = manifest["rooms"]["museum"]
new_objects = [o for o in foyer["objects"] if o["asset"] not in ["museum_desk", "museum_sign"]]
new_blockers = [b for b in foyer["blockers"] if not (b["y"] == 376 and b["width"] == 96)] # remove desk blockers

# Left desk centered at 288
new_objects.append({"asset": "museum_desk", "x": 288-24, "y": 400, "depth": 400, "scale": 1})
new_objects.append({"asset": "museum_desk", "x": 288+24, "y": 400, "depth": 400, "scale": 1})
new_blockers.append({"x": 288-48, "y": 376, "width": 96, "height": 40})
new_objects.append({"asset": "museum_sign", "x": 288, "y": 352, "depth": 399, "scale": 1})

# Right desk centered at 672
new_objects.append({"asset": "museum_desk", "x": 672-24, "y": 400, "depth": 400, "scale": 1})
new_objects.append({"asset": "museum_desk", "x": 672+24, "y": 400, "depth": 400, "scale": 1})
new_blockers.append({"x": 672-48, "y": 376, "width": 96, "height": 40})
new_objects.append({"asset": "museum_sign", "x": 672, "y": 352, "depth": 399, "scale": 1})

foyer["objects"] = new_objects
foyer["blockers"] = new_blockers

with open("/home/runner/workspace/artifacts/jpo-huddle/public/commercial-layouts.json", "w") as f:
    json.dump(manifest, f, indent=2)

print("Fixed foyer layout")
