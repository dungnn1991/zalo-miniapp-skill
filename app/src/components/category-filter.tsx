import { catalog } from "../data/catalog";

interface CategoryFilterProps {
  activeCategory: string;
  allCategoryId: string;
  onSelect: (categoryId: string) => void;
}

export default function CategoryFilter({
  activeCategory,
  allCategoryId,
  onSelect,
}: CategoryFilterProps) {
  const options = [
    { id: allCategoryId, label: catalog.allCategoryLabel },
    ...catalog.categories,
  ];

  return (
    <div className="category-filter" data-testid="category-filter">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={option.id === activeCategory ? "chip chip-active" : "chip"}
          onClick={() => onSelect(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
