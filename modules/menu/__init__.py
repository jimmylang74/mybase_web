import uuid


def find_menu_item(items, item_id):
    for item in items:
        if item['id'] == item_id:
            return item
        if 'children' in item:
            result = find_menu_item(item['children'], item_id)
            if result:
                return result
    return None


def add_menu_item(items, parent_id, new_item):
    if parent_id is None:
        items.append(new_item)
        return True
    parent = find_menu_item(items, parent_id)
    if parent:
        if 'children' not in parent:
            parent['children'] = []
        parent['children'].append(new_item)
        return True
    return False


def add_menu_item_after(items, new_item, after_id):
    for i, item in enumerate(items):
        if item['id'] == after_id:
            items.insert(i + 1, new_item)
            return True
        if item.get('children'):
            if add_menu_item_after(item['children'], new_item, after_id):
                return True
    return False


def update_menu_item(items, item_id, updates):
    item = find_menu_item(items, item_id)
    if item:
        for key, value in updates.items():
            if key != 'id' and key != 'children':
                item[key] = value
        return True
    return False


def delete_menu_item(items, item_id):
    deleted_ids = []

    def _delete_recursive(items_list):
        new_items = []
        for item in items_list:
            if item['id'] == item_id:
                deleted_ids.append(item['id'])
                _collect_descendants(item, deleted_ids)
                continue
            if 'children' in item:
                item['children'] = _delete_recursive(item['children'])
            new_items.append(item)
        return new_items

    def _collect_descendants(item, ids_list):
        for child in item.get('children', []):
            ids_list.append(child['id'])
            _collect_descendants(child, ids_list)

    updated = _delete_recursive(items)
    return updated, deleted_ids


def move_menu_item(items, item_id, direction):
    for i, item in enumerate(items):
        if item['id'] == item_id:
            if direction == 'up' and i > 0:
                items[i], items[i-1] = items[i-1], items[i]
                return True
            elif direction == 'down' and i < len(items) - 1:
                items[i], items[i+1] = items[i+1], items[i]
                return True
            return False
        if 'children' in item and item['children']:
            if move_menu_item(item['children'], item_id, direction):
                return True
    return False


def move_menu_item_to_parent(items, item_id, target_parent_id):
    item_to_move = None
    def find_and_remove(items_list):
        nonlocal item_to_move
        new_list = []
        for item in items_list:
            if item['id'] == item_id:
                item_to_move = item
                continue
            if 'children' in item:
                item['children'] = find_and_remove(item['children'])
            new_list.append(item)
        return new_list
    updated = find_and_remove(items)
    if item_to_move is None:
        return items, False
    if target_parent_id is None:
        updated.append(item_to_move)
    else:
        target = find_menu_item(updated, target_parent_id)
        if target is None:
            return items, False
        if 'children' not in target:
            target['children'] = []
        target['children'].append(item_to_move)
    return updated, True
